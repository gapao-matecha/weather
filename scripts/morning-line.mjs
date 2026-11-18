// 毎朝の天気サマリを LINE に送る（GitHub Actions から実行）
// 判定の基準はサイト（index.html）の「今日のポイント」と同じ。
//
// 環境変数:
//   LINE_CHANNEL_ACCESS_TOKEN  Messaging API のチャネルアクセストークン（GitHub Secrets）
//   LINE_USER_ID               送り先（自分）のユーザーID（GitHub Secrets）
//   WARD                       区の名前（省略時は目黒区）
//   DRY_RUN=1                  送らずに文面だけ表示する（トークン未設定のときも同じ）
//   TEST=1                     「【テスト送信】」付きで送る
//   RETRY_MINUTES              天気データが取れないとき、この分数のあいだ取り直す（省略時は3回だけ）

const WARDS = {
  千代田区: [35.6940, 139.7536], 中央区: [35.6706, 139.7720], 港区: [35.6581, 139.7516],
  新宿区: [35.6938, 139.7036], 文京区: [35.7080, 139.7521], 台東区: [35.7126, 139.7800],
  墨田区: [35.7107, 139.8015], 江東区: [35.6730, 139.8171], 品川区: [35.6092, 139.7302],
  目黒区: [35.6414, 139.6982], 大田区: [35.5613, 139.7160], 世田谷区: [35.6464, 139.6533],
  渋谷区: [35.6639, 139.6978], 中野区: [35.7074, 139.6638], 杉並区: [35.6995, 139.6364],
  豊島区: [35.7263, 139.7166], 北区: [35.7528, 139.7337], 荒川区: [35.7362, 139.7834],
  板橋区: [35.7512, 139.7094], 練馬区: [35.7356, 139.6517], 足立区: [35.7750, 139.8044],
  葛飾区: [35.7434, 139.8471], 江戸川区: [35.7067, 139.8683],
};
const SITE = 'https://gapao-matecha.github.io/weather/';
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const WMO = {
  0: '快晴', 1: '晴れ', 2: '晴れ時々くもり', 3: 'くもり', 45: '霧', 48: '霧',
  51: '霧雨', 53: '霧雨', 55: '霧雨', 56: '着氷性の霧雨', 57: '着氷性の霧雨',
  61: '小雨', 63: '雨', 65: '強い雨', 66: '着氷性の雨', 67: '着氷性の雨',
  71: '小雪', 73: '雪', 75: '大雪', 77: '霧雪', 80: 'にわか雨', 81: 'にわか雨', 82: '激しいにわか雨',
  85: 'にわか雪', 86: '激しいにわか雪', 95: '雷雨', 96: '雷雨（ひょう）', 99: '激しい雷雨',
};
const r0 = v => Math.round(v);
const r1 = v => Math.round(v * 10) / 10;

function feel(max, min) {
  const t = (max * 2 + min) / 3;
  if (t <= 5) return ['🥶', 'とても寒い', 'ダウンやマフラー、手袋で防寒をしっかり。'];
  if (t <= 11) return ['🧥', '寒い', 'コートやセーターなど冬物がおすすめ。'];
  if (t <= 16) return ['🧣', '肌寒い', '薄手のコートやジャケットを羽織って。'];
  if (t <= 21) return ['👕', '過ごしやすい', '長袖シャツやカーディガンでちょうど良さそう。'];
  if (t <= 26) return ['🌤️', '暖かい', '半袖〜薄手の長袖で快適。'];
  if (t <= 31) return ['🥵', '暑い', '半袖で。こまめな水分補給を。'];
  return ['🔥', '猛暑', '熱中症に厳重警戒。外出は涼しい時間帯に。'];
}

// 判定の対象は出勤後〜夜の 9〜22 時（寝ている時間帯は見ない）
const ACTIVE_FROM = 9, ACTIVE_TO = 22;
const activeHours = hours => hours.filter(h => h.hour >= ACTIVE_FROM && h.hour <= ACTIVE_TO);

function umbrella(hours) {
  const active = activeHours(hours);
  const maxProb = Math.max(...active.map(h => h.prob ?? 0));
  const sum = active.reduce((a, h) => a + (h.precip || 0), 0);
  const rainy = active.filter(h => (h.prob ?? 0) >= 50 || h.precip >= 0.5);
  const span = rainy.length ? `${rainy[0].hour}時〜${rainy.at(-1).hour + 1}時ごろ` : '';
  if (maxProb >= 60 || sum >= 2) return { head: '☂️ 傘を持って出かけよう', detail: `降水確率 最大${maxProb}%・日中 ${r1(sum)}mm${span ? `（${span}に雨）` : ''}` };
  if (maxProb >= 30 || sum >= 0.3) return { head: '🌂 折りたたみ傘があると安心', detail: `降水確率 最大${maxProb}%${span ? `（${span}に降るかも）` : ''}` };
  return { head: '😎 傘はいらなそう', detail: `降水確率 最大${maxProb}%` };
}

// Open-Meteo が数分単位でつながらないことがあるため、RETRY_MINUTES の間は間隔を空けながら取り直す
// （未指定なら3回だけ。毎朝の実行では長めに粘る）
async function fetchJSON(url) {
  const deadline = Date.now() + (Number(process.env.RETRY_MINUTES) || 0) * 60_000;
  let last;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return await res.json();
      last = new Error(`Open-Meteo HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
    const wait = Math.min(60_000, 5000 * 2 ** i); // 5秒・10秒・20秒・40秒・以降1分おき
    if (i >= 2 && Date.now() + wait > deadline) break;
    console.error(`天気データの取得に失敗（${last.cause?.code || last.message}）。${wait / 1000}秒後に取り直します`);
    await new Promise(r => setTimeout(r, wait));
  }
  throw last;
}

// 天気が取れなかった朝に送る文面
function fallbackText() {
  const ward = WARDS[process.env.WARD] ? process.env.WARD : '目黒区';
  const jst = new Date(Date.now() + 9 * 3600_000);
  const date = `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}(${DOW[jst.getUTCDay()]})`;
  return [
    '⚠️ 今朝は天気データを取得できませんでした',
    `📍 ${ward} ${date}`,
    '',
    '天気の提供元につながらなかったため、サマリを作れませんでした。',
    `最新の天気はサイトで確認してください：${SITE}?ward=${encodeURIComponent(ward)}`,
  ].join('\n');
}

async function buildText() {
  const ward = WARDS[process.env.WARD] ? process.env.WARD : '目黒区';
  const [lat, lon] = WARDS[ward];
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'Asia/Tokyo', past_days: 1, forecast_days: 1,
    hourly: 'temperature_2m,precipitation,precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,uv_index_max,wind_speed_10m_max',
  });
  const { daily: D, hourly: H } = await fetchJSON(url);

  // daily は [昨日, 今日]
  const date = D.time[1];
  const today = { code: D.weather_code[1], max: D.temperature_2m_max[1], min: D.temperature_2m_min[1], uv: D.uv_index_max[1], wind: D.wind_speed_10m_max[1] };
  const yestMax = D.temperature_2m_max[0];
  const hours = H.time.map((t, i) => ({ t, hour: +t.slice(11, 13), temp: H.temperature_2m[i], precip: H.precipitation[i], prob: H.precipitation_probability[i] }))
    .filter(h => h.t.startsWith(date));

  // 服装・寒暖差は 9〜22 時の気温で判定（早朝の最低気温は使わない）
  const temps = activeHours(hours).map(h => h.temp).filter(v => v != null);
  const dayMax = temps.length ? Math.max(...temps) : today.max;
  const dayMin = temps.length ? Math.min(...temps) : today.min;
  const [fe, ft, fd] = feel(dayMax, dayMin);
  const u = umbrella(hours);
  const notes = [];
  const diff = r1(today.max - yestMax);
  if (Math.abs(diff) >= 1) notes.push(`${diff > 0 ? '📈' : '📉'} 昨日より${Math.abs(diff)}℃${diff > 0 ? '高い' : '低い'}`);
  if (dayMax - dayMin >= 7) notes.push(`🌡️ 日中の寒暖差 ${r0(dayMax - dayMin)}℃（${ACTIVE_FROM}〜${ACTIVE_TO}時で ${r0(dayMin)}〜${r0(dayMax)}℃）`);
  if (today.uv >= 6) notes.push(`🧴 紫外線が強い（UV ${r1(today.uv)}）`);
  if (today.wind >= 30) notes.push(`💨 風が強い（最大 ${r0(today.wind / 3.6)}m/s）`);

  const dow = DOW[new Date(date + 'T12:00:00Z').getUTCDay()];
  const lines = [
    u.head,
    `📍 ${ward} ${+date.slice(5, 7)}/${+date.slice(8)}(${dow}) ${WMO[today.code] ?? ''} ${r0(today.max)}℃ / ${r0(today.min)}℃`,
    '',
    `${fe} ${ft}：${fd}`,
    `💧 ${u.detail}`,
    ...notes,
    '',
    `詳しくは ${SITE}?ward=${encodeURIComponent(ward)}`,
  ];
  return lines.join('\n');
}

async function main() {
  // 天気が取れなくても何も届かない朝にならないよう、代わりの文面を送る
  // TEST=1（手動実行）のときは「テスト送信」と分かるようにする
  let text;
  try {
    text = await buildText();
  } catch (e) {
    console.error(`天気データを取得できませんでした（${e.cause?.code || e.message}）。代わりの文面を送ります。`);
    console.log('::warning::天気データを取得できなかったため、代わりの文面を送りました');
    text = fallbackText();
  }
  if (process.env.TEST) text = `【テスト送信】\n${text}`;

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN, to = process.env.LINE_USER_ID;
  if (process.env.DRY_RUN || !token || !to) {
    console.log(text);
    if (!process.env.DRY_RUN) console.log('\n（LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID が未設定のため送信していません）');
    return;
  }
  const send = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  });
  if (!send.ok) throw new Error(`LINE HTTP ${send.status}: ${await send.text()}`);
  console.log('LINE に送信しました');
}

main().catch(e => { console.error(e); process.exit(1); });
