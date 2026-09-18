/* ========================================================== recordpage.mjs ===
   記録票（wiki の record: 頁）の本文を、受付の用紙（form.html）の中身から組む。
   様式は wiki の template:record（様式2 v4）と同じ形にする。直すときは両方直すこと。

   様式2 v4 の要点
     01 観測   発見者の言葉。書き換えない
     02 照合   三行。かつて（地層）／今（いま）／現象（一語）。空いている行は誰でも追伸で埋める
     06 追伸   外部回線の返信・引用と、受付の用紙から届いた言葉が並ぶ（postscript.html）

   ここで作るのは「受付経由」の記録だけ。外部回線の記録は仮記録票（record.html）に並び、
   記述者が記録票を起こす。
   ========================================================================= */

export const CODE_NAME = {
  STAY:'停滞', STRA:'層露', FORK:'分岐', LOOP:'反復',
  FLEX:'伸縮', REVE:'逆行', DEJA:'既視', CHAO:'混沌', OOPA:'OOPArts',
};

/* Wikidot の記法として効いてしまう文字を、見たままの文字に置き換える。
   参加者の言葉がそのまま構文になると、頁が壊れるか、別の頁を取り込めてしまう。 */
export function wdText(s, cap = 400) {
  const t = String(s || '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  return Array.from(t).slice(0, cap).join('')
    .replace(/\[\[/g, '［［').replace(/\]\]/g, '］］')
    .replace(/\[!--/g, '［!--').replace(/--\]/g, '--］')
    .replace(/@@/g, '＠＠').replace(/\|\|/g, '｜｜')
    .replace(/^([+*#>=\-])/gm, '\u200b$1')        /* 行頭の見出し・箇条書き・引用を止める */
    .replace(/\/\//g, '／／').replace(/\*\*/g, '＊＊').replace(/__/g, '＿＿')
    .replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝').replace(/\^\^/g, '＾＾').replace(/,,/g, '，，')
    .replace(/\n{2,}/g, '\n');
}
const one = (s, cap) => wdText(s, cap).replace(/\n+/g, ' ');

export function cellOf(coord) {
  const m = /^KYOTO\/([A-H][1-8])/.exec(coord || '');
  return m ? 'KYOTO-' + m[1] : null;
}

/* 待ち。欠けているものを、同名のタグで示す（用語集 §4）。 */
export function waitsOf(r) {
  const w = [];
  if (!r.then || !r.now || !r.code) w.push('記述待ち');
  if (!r.coord) w.push('座標待ち');
  if (!r.img) w.push('現状報告待ち');     /* 写真の無い記録は、いまの一枚を待つ */
  return w;
}

export function recordTags(r) {
  const t = new Set(['観測記録', '保留', '受付経由']);
  const c = cellOf(r.coord);
  if (c) t.add(c.toLowerCase());
  if (r.code && CODE_NAME[r.code]) t.add(r.code.toLowerCase());
  waitsOf(r).forEach(x => t.add(x));
  return [...t];
}

/* r = { aid, title, code, coord, pano, then, now, obs, name, finder, at }
   finder があれば外部回線の発見者（記録票をつくる経路）、無ければ受付経由の本人 */
export function recordSource(r) {
  const aid   = r.aid;
  const code  = r.code && CODE_NAME[r.code] ? r.code : null;
  const cell  = cellOf(r.coord);
  const d     = new Date(r.at || Date.now());
  const jst   = new Date(d.getTime() + 9 * 3600 * 1000).toISOString();
  const date  = jst.slice(0, 10).replace(/-/g, '.') + ' / ' + jst.slice(11, 16);
  const name  = one(r.name, 12) || '名を残さなかった観測員';
  const blank = (s, form) => s ? one(s, 80) : `@@${form}@@`;
  const title = one(r.title, 40) || '（表題なし）';
  const img   = r.img && /^https:\/\/pbs\.twimg\.com\/[^\s\]|"]+$/.test(r.img) ? r.img : null;
  const shot  = img ? `[[div class="rec-shot"]]\n[[image ${img} alt="${aid}"]]\n[[/div]]`
                    : `[[div class="rec-shot"]]\nSOURCE IMAGE　/　NOT ATTACHED（現状報告待ち）\n[[/div]]`;

  return `[!--
    受付の用紙（form.html）から fateofether が起こした記録票。様式2 v4。
    照合の三行は、空いている所を誰でも追伸で埋められます。
--]

[[include inc:record-style]]

[[div class="rec"]]

[[div class="rec-bar"]]
OBSERVATION RECORD　/　観測センター 記録保管室
[[/div]]

[[div class="rec-head"]]
[[div class="rec-lbl"]]
ARCHIVE ID
[[/div]]
[[div class="rec-id"]]
${aid}
[[/div]]
[[div class="rec-title"]]
${title}
[[/div]]
[[/div]]

[[div class="rec-meta"]]
||~ PHENOMENON || ${code ? code + aid.slice(-4) : '—— 未見立て'} ||
||~ CATEGORY || ${code ? CODE_NAME[code] : '—— 未見立て'} ||
||~ LAYER || 不明 ||
||~ CELL || ${cell || (r.coord ? '盤の外' : '—— 座標待ち')} ||
||~ PLACE || ${r.coord ? one(r.coord, 40) : '—— 未定'} ||
||~ DATE / TIME || ${date} ||
||~ STATUS || 保留 ||
||~ PANO ID || ${r.pano ? one(r.pano, 80) : '—— 未確認'} ||
[[/div]]

[[div class="rec-people"]]
[[span]][[span class="k"]]FINDER[[/span]] 観測員 ${r.finder ? one(r.finder, 12) : name + '（受付経由）'}[[/span]]
[[span]][[span class="k"]]WRITER[[/span]] 観測員 ${name}[[/span]]
[[span]][[span class="k"]]PROCEDURE[[/span]]—— 未処置[[/span]]
[[/div]]

[[div class="rec-sec"]]
[[div class="rec-sec-h"]]
[[span class="rec-no"]]01[[/span]] [[span class="rec-sec-t"]]OBSERVATION / 観測[[/span]]
[[/div]]

${shot}

[[div class="rec-em"]]
${wdText(r.obs, 300) || '（言葉なし）'}
[[/div]]

[[div class="rec-note"]]
この欄は書き換えないでください。発見者の言葉です。
[[/div]]
[[/div]]

[[div class="rec-sec"]]
[[div class="rec-sec-h"]]
[[span class="rec-no"]]02[[/span]] [[span class="rec-sec-t"]]COLLATION / 照合[[/span]]
[[/div]]

[[div class="rec-tbl"]]
||~ 照合 ||~ 記述 ||
|| THEN / かつて || ${blank(r.then, 'かつて、ここは ＿＿＿ だった。')} ||
|| NOW / いま || ${blank(r.now, '今、ここは ＿＿＿ である。')} ||
|| GAP / 現象 || ${code ? CODE_NAME[code] : '@@＿＿（一語）@@'} ||
[[/div]]

[[div class="rec-note"]]
空いている行は、誰が埋めても構いません。追伸で送ってください。
[[/div]]
[[/div]]

[[div class="rec-sec"]]
[[div class="rec-sec-h"]]
[[span class="rec-no"]]06[[/span]] [[span class="rec-sec-t"]]POSTSCRIPT / 追伸[[/span]]
[[/div]]

[[div class="rec-note"]]
この記録に言葉や写真を足すときは、外部回線（X）で @alembicity に宛てて @@${aid}@@ を添えて投稿するか、[[[https://mayshare.chu.jp/center/form.html?ps=${aid} | 受付の用紙]]] から送ってください。登録は要りません。届いた追伸は、6時間ごとの現像でこの下に並びます。
[[/div]]
[[iframe https://mayshare.chu.jp/center/postscript.html?id=${aid} style="width:100%;height:220px;border:0" frameborder="0" scrolling="yes"]]
[[/div]]

[[div class="rec-foot"]]
OBSERVATION CENTER / RECORD ARCHIVE
RECORD STATUS / ARCHIVED
[[/div]]

[[/div]]
`;
}

/* 既存の記録票の末尾に足す、受付経由の追伸の一片。
   処置班が本文へ繰り上げるまでは、この形のまま残る。 */
export function postscriptBlock(r) {
  const d   = new Date(r.at || Date.now());
  const jst = new Date(d.getTime() + 9 * 3600 * 1000).toISOString();
  const rows = [
    r.then ? `|| THEN / かつて || ${one(r.then, 80)} ||` : '',
    r.now  ? `|| NOW / いま || ${one(r.now, 80)} ||` : '',
    r.code && CODE_NAME[r.code] ? `|| GAP / 現象 || ${CODE_NAME[r.code]} ||` : '',
  ].filter(Boolean).join('\n');
  const via = r.via === 'x' ? '外部回線' : '受付経由';
  const img = r.img && /^https:\/\/pbs\.twimg\.com\/[^\s\]|"]+$/.test(r.img) ? `[[image ${r.img} width="240px"]]\n` : '';
  const link = r.url && /^https:\/\/(x|twitter)\.com\/[^\s\]|"]+$/.test(r.url) ? ` [${r.url} 元の投稿]` : '';
  return `
[!-- 追伸 ${r.id} --]
[[div class="rec-note"]]
**追伸** ${jst.slice(0, 10).replace(/-/g, '.')} ${jst.slice(11, 16)}　観測員 ${one(r.name, 12) || '名を残さなかった観測員'}（${via}・未統合）${link}
${img}${r.obs ? wdText(r.obs, 300) : ''}
[[/div]]
${rows ? '[[div class="rec-tbl"]]\n' + rows + '\n[[/div]]' : ''}
`;
}
