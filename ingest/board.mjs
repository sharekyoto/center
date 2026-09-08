/* ============================================================================
   座標の語彙 ── 盤側（template.html の CONFIG）と揃えること
   ----------------------------------------------------------------------------
   ここと盤で定義がずれると、同じタグが別の場所を指す。
   触るときは必ず両方直す。
   ============================================================================ */

/* 盤の標準寸法。京都盤と同じ大きさ。 */
export const BOARD_SIZE = { lat: 0.03859100, lng: 0.04933400 };

/* 盤の中の座標。町の記号が a–h まで伸びるのは、京都の UMEKOJI が
   2×2 の坊に 8×8 を張った legacy だから。a–d だけにすると E6f3 を取りこぼす。 */
export const COORD_RE = /#([A-Z][A-Z0-9]{1,15})_([A-H][1-8](?:[a-hA-H][1-8])*)\b/;

/* ── 地点符号（盤の外）───────────────────────────
   0.001度 = 京都でおよそ 110m × 91m。小数第4位以下は切り捨て。
   四捨五入にしないのは、切り捨てなら区画がすき間なく敷き詰まり、
   境界がどちらに属するか迷わなくて済むため。 */
export const SEED_STEP = 0.001;
export const SEED_RE   = /#([NS])(\d{4,5})_([EW])(\d{5,6})\b/;   // 旧4/5桁も読む

const pad = (v, w) => String(Math.floor(Math.abs(v) * 1000 + 1e-9)).padStart(w, '0');

export function seedOf(lat, lng){
  return (lat >= 0 ? 'N' : 'S') + pad(lat, 5) + '_' + (lng >= 0 ? 'E' : 'W') + pad(lng, 6);
}

/* 地点符号 → 南西角・一辺・中心。旧 0.01度表記も読める */
export function seedBox(code){
  const m = SEED_RE.exec('#' + String(code).replace(/^#/, '').toUpperCase());
  if(!m) return null;
  const div  = m[2].length >= 5 ? 1000 : 100;
  const step = 1 / div;
  const lat = (m[1] === 'N' ?  1 : -1) * parseInt(m[2], 10) / div;
  const lng = (m[3] === 'E' ?  1 : -1) * parseInt(m[4], 10) / div;
  return { lat, lng, step, clat: lat + step / 2, clng: lng + step / 2 };
}

/* 盤の中なら区画符号、外なら地点符号。null を返さない。
   ここが「必ず何かを返す」ことが今回の修正の核心。 */
export const KYOTO = { minLat:34.97929395, maxLat:35.01788495,
                       minLng:135.717924,  maxLng:135.767258 };
export const COLS = ['A','B','C','D','E','F','G','H'];   /* A が最も東 */

/* 緯度経度 → 'E6'。盤の外なら null。tele/map の cellAt と同一定義 */
export function cellAt(lat, lng, K){
  K = K || KYOTO;
  if(lat < K.minLat || lat >= K.maxLat || lng < K.minLng || lng >= K.maxLng) return null;
  const h = (K.maxLat - K.minLat) / 8, w = (K.maxLng - K.minLng) / 8;
  let row = Math.floor((K.maxLat - lat) / h) + 1;
  let col = Math.floor((K.maxLng - lng) / w) + 1;
  row = Math.min(8, Math.max(1, row)); col = Math.min(8, Math.max(1, col));
  return COLS[col-1] + row;
}

export function tagFor(lat, lng){
  const cell = cellAt(lat, lng);            // 盤外では null
  return cell ? `#KYOTO_${cell}` : `#${seedOf(lat, lng)}`;
}
/* タグの揺れを吸収する。
   ------------------------------------------------------------------
   触るのは「#」で始まる語だけ。本文は一字も変えない。
     ＃ｋｙｏｔｏ＿Ｅ６ｇ３ → #KYOTO_E6g3   （全角を NFKC で半角に）
     #kyoto_e6g3b7        → #KYOTO_E6g3b7 （盤名と第一セルを大文字に）
     #n3499_e13574        → #N3499_E13574 （地点キーも同様）
   大文字化は受け口を広げるだけなので、既存タグの指す場所は動かない。 */
export function normalizeTags(text){
  return String(text || '').replace(/[#＃][^\s#＃]+/gu, tag => {
    const t = tag.normalize('NFKC').replace(/^＃/, '#');
    const c = /^#([A-Za-z][A-Za-z0-9]{1,15})_([A-Ha-h][1-8](?:[A-Ha-h][1-8])*)$/.exec(t);
    if(c) return '#' + c[1].toUpperCase() + '_' + c[2][0].toUpperCase() + c[2].slice(1);
    /* 0.001度に細かくしたので、桁が 4/5 → 5/6 に増える。
       旧 4/5桁（0.01度）の投稿も読めるよう、両方を許す。 */
    const d = /^#([NnSs])(\d{4,5})_([EeWw])(\d{5,6})$/.exec(t);
    if(d) return '#' + d[1].toUpperCase() + d[2] + '_' + d[3].toUpperCase() + d[4];
    return t;
  });
}

const ix  = v => Math.floor(v / SEED_STEP + 1e-9);
const padKey = (n, w) => String(Math.abs(n)).padStart(w, '0');

export function seedKey(lat, lng){
  const la = ix(lat), ln = ix(lng);
  return (la < 0 ? 'S' : 'N') + padKey(la, 4) + '_' + (ln < 0 ? 'W' : 'E') + padKey(ln, 5);
}
export function seedKeyBounds(key){
  const m = /^([NS])(\d{4,6})_([EW])(\d{5,7})$/.exec(String(key || ''));
  if (!m) return null;
  const step = m[2].length >= 5 ? 0.001 : 0.01;   /* 旧 4/5桁（0.01度）も読む */
  const la = (m[1] === 'S' ? -1 : 1) * parseInt(m[2], 10);
  const ln = (m[3] === 'W' ? -1 : 1) * parseInt(m[4], 10);
  return { minLat: la * step, maxLat: (la + 1) * step,
           minLng: ln * step, maxLng: (ln + 1) * step };
}
export const centerOf = bb => ({ lat: (bb.minLat + bb.maxLat) / 2,
                                 lng: (bb.minLng + bb.maxLng) / 2 });

/* 八つ目が落ちた地点を中心に、標準寸法で切り出す。
   既存の盤と重なる場合だけ、重なりの小さい軸へ最小限ずらす。
   —— 生成は一度きり。以後この矩形は動かさない。
   （template.html の deriveBoard と同一。片方だけ直さないこと） */
export function deriveBoard(center, existing){
  const h = BOARD_SIZE.lat / 2, w = BOARD_SIZE.lng / 2;
  const b = { minLat: center.lat - h, maxLat: center.lat + h,
              minLng: center.lng - w, maxLng: center.lng + w };
  (existing || []).forEach(o => {
    const ov = {
      lat: Math.min(b.maxLat, o.maxLat) - Math.max(b.minLat, o.minLat),
      lng: Math.min(b.maxLng, o.maxLng) - Math.max(b.minLng, o.minLng),
    };
    if (ov.lat <= 0 || ov.lng <= 0) return;
    if (ov.lat <= ov.lng) {
      const d = ov.lat * (center.lat >= (o.minLat + o.maxLat) / 2 ? 1 : -1);
      b.minLat += d; b.maxLat += d;
    } else {
      const d = ov.lng * (center.lng >= (o.minLng + o.maxLng) / 2 ? 1 : -1);
      b.minLng += d; b.maxLng += d;
    }
  });
  return b;
}
