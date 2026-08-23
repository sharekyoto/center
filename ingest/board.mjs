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

/* 盤の外の地点。0.01度（緯度で約1.1km・経度で約0.9km）に丸めた升目。
     34.9902,135.7398 → N3499_E13574
   小数点はハッシュタグに使えず、数字だけのタグは成立しないので、
   桁数を固定して点を落とし、頭に N/S・E/W を付けている。 */
export const SEED_STEP = 0.01;
export const SEED_RE   = /#([NS])(\d{4})_([EW])(\d{5})\b/;

const ix  = v => Math.floor(v / SEED_STEP + 1e-9);
const pad = (n, w) => String(Math.abs(n)).padStart(w, '0');

export function seedKey(lat, lng){
  const la = ix(lat), ln = ix(lng);
  return (la < 0 ? 'S' : 'N') + pad(la, 4) + '_' + (ln < 0 ? 'W' : 'E') + pad(ln, 5);
}
export function seedKeyBounds(key){
  const m = /^([NS])(\d{4})_([EW])(\d{5})$/.exec(String(key || ''));
  if (!m) return null;
  const la = (m[1] === 'S' ? -1 : 1) * parseInt(m[2], 10);
  const ln = (m[3] === 'W' ? -1 : 1) * parseInt(m[4], 10);
  return { minLat: la * SEED_STEP, maxLat: (la + 1) * SEED_STEP,
           minLng: ln * SEED_STEP, maxLng: (ln + 1) * SEED_STEP };
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
