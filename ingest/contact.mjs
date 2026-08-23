/* ============================================================================
   現像 ／ フィルム片を焼く
   ----------------------------------------------------------------------------
   その回に届いた観測を最大4つ、35mm フィルムの切れ端の形に組んで1枚にする。

   なぜ1枚にするか
     ・縦横がばらばらの写真をそのまま4枚並べると、投稿の見た目が毎回変わる。
       同じ枠に流し込めば、誰が撮っても同じ「この街のもの」になる。
     ・アップロードするメディアが4件から1件になる。課金単位が不明でも上限が読める。
     ・「写るんです」の色を焼き込めるので、X 上でも盤と同じ色になる。
     ・原寸の転載ではなく観測票になる。顔が写り込んでも、この大きさでは判別できない。

   文字はすべて英数字だけにしてあります。実行環境に日本語フォントが無くても崩れません
   （フィルムの縁の刻印はもともと英数字なので、世界観としても正しい）。

   使い方  const buf = await buildStrip([{img, coord, by}, ...], '2026-08-22 18:00');
   ============================================================================ */

import sharp from 'sharp';

/* 「写るんです」。grid-map.html の CONFIG.FILM と同じ値を、こちらでは焼き込む。 */
const FILM = {
  saturation: 1.26,
  contrast: 0.92,
  brightness: 1.06,
  shadow: { r:0x24, g:0x38, b:0x2C, a:0.12 },   // 影が緑に転ぶ
  warm:   { r:0xFF, g:0xD9, b:0xA5, a:0.17 },   // ハイライトが黄に寄る
  vignette: 0.30,
  grain: 0.20,
};

const L = {
  frameW: 460, frameH: 307,     // 3:2。全部ここに合わせて中央で切る
  rail: 52,                     // パーフォレーションの帯＋刻印
  gapX: 14, gapY: 20,
  pad: 22, caption: 54,
  ground: '#14171A', film: '#0E1214', stamp: '#F0803C', edge: '#8E999E',
};
const W = L.pad*2 + L.frameW*2 + L.gapX;
const stripH = L.rail*2 + L.frameH;
const H = L.pad + stripH*2 + L.gapY + L.caption;

const solid = (w,h,c) => sharp({ create:{ width:w, height:h, channels:4,
  background:{ r:c.r, g:c.g, b:c.b, alpha:c.a } }}).png().toBuffer();

const svgBuf = s => Buffer.from(s);

/* 一コマ分。中央で 3:2 に切り、色を焼き込む。 */
async function developFrame(input, ow, oh){
  const w = ow || L.frameW, h = oh || L.frameH;
  // 現像機は構図を選ばない。中央で切る。
  let img = sharp(input).rotate().resize(w, h, { fit:'cover', position:'centre' });

  // 彩度・コントラスト・明るさ
  const a = FILM.contrast * FILM.brightness;
  const b = 128 * (1 - FILM.contrast) * FILM.brightness;
  img = img.modulate({ saturation: FILM.saturation }).linear(a, b);

  const base = await img.png().toBuffer();
  const grain = svgBuf(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2"/></filter>
      <rect width="${w}" height="${h}" filter="url(#n)" opacity="${FILM.grain}"/></svg>`);
  const vig = svgBuf(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><radialGradient id="v" cx="50%" cy="47%" r="72%">
        <stop offset="46%" stop-color="#fff" stop-opacity="1"/>
        <stop offset="100%" stop-color="#000" stop-opacity="${FILM.vignette}"/>
      </radialGradient></defs>
      <rect width="${w}" height="${h}" fill="url(#v)"/></svg>`);

  return sharp(base).composite([
    { input: await solid(w,h,FILM.shadow), blend:'lighten'  },
    { input: await solid(w,h,FILM.warm),   blend:'multiply' },
    { input: vig,   blend:'multiply' },
    { input: grain, blend:'overlay'  },
  ]).png().toBuffer();
}

/* フィルムの地。パーフォレーションと縁の刻印。
   刻印にアカウント名を入れてある。この画像は引用されて独り歩きするので、
   画像そのものが「どこへ行けばいいか」を持っていないと、拡散が流入にならない。 */
function filmSvg(items, at, account){
  const perf = [];
  for(let s=0; s<2; s++){
    const top = L.pad + s*(stripH + L.gapY);
    for(let y of [top + 7, top + stripH - 7 - 12]){
      for(let x = L.pad - 2; x < W - L.pad - 16; x += 32){
        perf.push(`<rect x="${x}" y="${y}" width="18" height="12" rx="3" fill="${L.ground}"/>`);
      }
    }
  }
  const marks = items.map((it,i)=>{
    const s = i>>1, c = i&1;
    const x = L.pad + c*(L.frameW + L.gapX);
    const top = L.pad + s*(stripH + L.gapY);
    return `<text x="${x+3}" y="${top + L.rail - 9}" font-family="monospace" font-size="15"
              fill="${L.stamp}" letter-spacing="1.4">${it.coord}</text>
            <text x="${x + L.frameW - 3}" y="${top + L.rail - 9}" text-anchor="end"
              font-family="monospace" font-size="15" fill="${L.edge}" letter-spacing="1.4">${it.by}</text>
            <text x="${x+3}" y="${top + stripH - 30}" font-family="monospace" font-size="13"
              fill="${L.edge}" letter-spacing="2">${String(i+1).padStart(2,'0')}A</text>
            <text x="${x + L.frameW - 3}" y="${top + stripH - 30}" text-anchor="end"
              font-family="monospace" font-size="12" fill="${L.edge}"
              letter-spacing="1.2">${(it.handle ? '@'+it.handle : 'UNSIGNED')}</text>`;
  }).join('');

  return svgBuf(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${L.ground}"/>
    ${[0,1].map(s=>`<rect x="${L.pad-8}" y="${L.pad + s*(stripH+L.gapY)}"
        width="${W - (L.pad-8)*2}" height="${stripH}" fill="${L.film}"/>`).join('')}
    ${perf}${marks}
    <text x="${L.pad}" y="${H - 20}" font-family="monospace" font-size="14"
      fill="${L.edge}" letter-spacing="2.4">FERMENTED CITY / DEVELOPED ${at}</text>
    <text x="${W - L.pad}" y="${H - 20}" text-anchor="end" font-family="monospace" font-size="14"
      fill="${L.stamp}" letter-spacing="2.4">@${account} / ISO400</text>
  </svg>`);
}

/* items: [{ img, coord, by, handle }] 最大4件。返り値は JPEG の Buffer。 */
export async function buildStrip(items, at, account='alembicity'){
  const use = items.slice(0, 4);
  const frames = await Promise.all(use.map(async it => {
    try{
      const r = await fetch(it.img);
      if(!r.ok) return null;
      return await developFrame(Buffer.from(await r.arrayBuffer()));
    }catch{ return null; }
  }));

  const layers = [{ input: filmSvg(use, at, account), top:0, left:0 }];
  frames.forEach((f,i)=>{
    if(!f) return;
    const s = i>>1, c = i&1;
    layers.push({ input:f,
      left: L.pad + c*(L.frameW + L.gapX),
      top:  L.pad + s*(stripH + L.gapY) + L.rail });
  });

  return sharp({ create:{ width:W, height:H, channels:3,
                          background:{ r:0x14, g:0x17, b:0x1A } }})
    .composite(layers).jpeg({ quality:86, progressive:true }).toBuffer();
}

export const STRIP_SIZE = { W, H };

/* ============================================================================
   一葉 ／ 言葉が焼き込まれた観測票
   ----------------------------------------------------------------------------
   写真1コマ＋座標＋観測者番号＋他人が付けた言葉を、1枚に焼く。

   これが「説明が拡散していく」経路の実体です。
     四時間ごとの現像（フィルム片）は写真だけ。写真が先に来る。
     言葉が付いた観測は、一日一回この形で出す。
     つまり写真も言葉も、同じ視覚言語のまま外に出ていく。

   和文を描くので、実行環境に日本語フォントが要ります。
   GitHub Actions なら  sudo apt-get install -y fonts-noto-cjk  の一行で入ります。
   ============================================================================ */

const LEAF = {
  frameW: 900, frameH: 600,      // 3:2
  pad: 34, rail: 56, foot: 46, capMin: 200,
  jp: "'Noto Sans CJK JP','Noto Sans JP','Hiragino Sans',sans-serif",
};

const esc = s => String(s||'').replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

/* ざっくり全角換算で折る。和文は等幅に近いので、これで十分読める行になります。 */
function wrapJa(s, per){
  const out = []; let line = '';
  for(const ch of String(s||'')){
    line += ch;
    if(line.length >= per || ch === '\n'){ out.push(line.replace('\n','')); line = ''; }
  }
  if(line) out.push(line);
  return out;
}

/* item: { img, coord, alias, by, handle, tx, words:[{by,tx}], at } */
export async function buildLeaf(item, account='alembicity'){
  const { frameW:W2, frameH:H2, pad, rail } = LEAF;
  const width = W2 + pad*2;

  const say   = wrapJa(item.tx, 26);
  const words = (item.words||[]).slice(0, 3)
    .flatMap(w => wrapJa(w.tx, 26).map((t,i)=>({ by: i===0 ? w.by : '', t })));
  const capH  = Math.max(LEAF.capMin, LEAF.foot + 62 + say.length*38 + (words.length ? 26 + words.length*32 : 0));
  const height = pad + rail + H2 + capH;

  const frame = await developFrame(await (async () => {
    const r = await fetch(item.img);
    if(!r.ok) throw new Error('image fetch failed');
    return Buffer.from(await r.arrayBuffer());
  })(), W2, H2);

  let y = pad + rail + H2 + LEAF.foot + 40;
  const sayTx = say.map(t => {
    const el = `<text x="${pad}" y="${y}" font-family=${JSON.stringify(LEAF.jp)}
        font-size="27" fill="#E7ECEE">${esc(t)}</text>`; y += 38; return el;
  }).join('');
  y += words.length ? 24 : 0;
  const wordTx = words.map(w => {
    const el = `${w.by ? `<text x="${pad}" y="${y}" font-family="monospace" font-size="17"
          fill="#8E999E" letter-spacing="1.2">${esc(w.by)}</text>` : ''}
      <text x="${pad + 62}" y="${y}" font-family=${JSON.stringify(LEAF.jp)}
        font-size="21" fill="#97A3A8">${esc(w.t)}</text>`; y += 32; return el;
  }).join('');

  const perf = [];
  for(const py of [pad + 10, pad + rail + H2 + 10]){
    for(let x = pad - 4; x < width - pad - 14; x += 34){
      perf.push(`<rect x="${x}" y="${py}" width="18" height="12" rx="3" fill="#14171A"/>`);
    }
  }

  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#14171A"/>
    <rect x="${pad-12}" y="${pad}" width="${width-(pad-12)*2}" height="${rail + H2 + LEAF.foot}" fill="#0E1214"/>
    ${perf.join('')}
    <text x="${pad}" y="${pad + rail - 12}" font-family="monospace" font-size="24"
      fill="#F0803C" letter-spacing="2">${esc(item.coord)}</text>
    <text x="${width - pad}" y="${pad + rail - 12}" text-anchor="end" font-family="monospace"
      font-size="24" fill="#8E999E" letter-spacing="2">${esc(item.by)}</text>
    ${item.alias ? `<text x="${pad}" y="${pad + rail + H2 + 30}" font-family=${JSON.stringify(LEAF.jp)}
      font-size="18" fill="#6B767B" letter-spacing="2">${esc(item.alias)}</text>` : ''}
    <text x="${width - pad}" y="${pad + rail + H2 + 30}" text-anchor="end" font-family="monospace"
      font-size="16" fill="#6B767B" letter-spacing="1.4">${item.handle ? '@'+esc(item.handle) : 'UNSIGNED'}</text>
    ${sayTx}${wordTx}
    <text x="${pad}" y="${height - 22}" font-family="monospace" font-size="15"
      fill="#4E5457" letter-spacing="2.4">FERMENTED CITY / ${esc(item.at||'')}</text>
    <text x="${width - pad}" y="${height - 22}" text-anchor="end" font-family="monospace"
      font-size="15" fill="#F0803C" letter-spacing="2.4">@${esc(account)}</text>
  </svg>`);

  return sharp({ create:{ width, height, channels:3, background:{ r:0x14, g:0x17, b:0x1A } }})
    .composite([{ input: svg, top:0, left:0 },
                { input: frame, left: pad, top: pad + rail }])
    .jpeg({ quality:86, progressive:true }).toBuffer();
}
