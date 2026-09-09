/* ============================================================================
   町名の語彙 ── #下京区朱雀宝蔵町 を座標に変える
   ----------------------------------------------------------------------------
   人が打てるのは地名だけである。#N35012_E135742 を手で打つ者はいない。
   だから外部回線では町名で受け取り、ここで座標へ翻訳する。

   国土地理院の住所検索を使う。鍵も申請も要らない。
   一度引いた町名は data/places.json に貯まり、二度目からは回線を使わない。
   見つからなかった町名も憶える。同じ空振りを毎回くり返さないため。
   ============================================================================ */

import { COORD_RE, SEED_RE, tagFor } from './board.mjs';

const ENDPOINT = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

/* 本文中のハッシュタグ。ここでは長さだけで切り出す。 */
const TAG_RE = /[#＃]([^\s#＃]{2,24})/gu;

/* 市区町村の字を含まない語は、地名として引かない。 */
const HAS_MUNI = /[区市町村]/;

/* 合言葉。地名でないと分かっているものは引かない。
   （「発酵都市観測センター」は「市」を含むので、ここに書かないと一度だけ引かれる） */
const SKIP = new Set(['観測センター', '発酵都市観測センター', '窓', '盤']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 本文から、地名らしいタグだけを順に取り出す */
export function townTags(text){
  const out = [];
  for(const m of String(text || '').matchAll(TAG_RE)){
    const t = m[1].normalize('NFKC');
    if(!HAS_MUNI.test(t)) continue;
    if(SKIP.has(t)) continue;
    if(!out.includes(t)) out.push(t);
  }
  return out;
}

/* 住所検索に一度だけ尋ねる。
   候補が一つに定まらない町名は採らない。
   「#本町」は全国に三千件ある。取り違えるくらいなら、未定位のままのほうがよい。 */
async function ask(name){
  const r = await fetch(ENDPOINT + '?q=' + encodeURIComponent(name));
  if(!r.ok) throw new Error('AddressSearch ' + r.status);
  const j = await r.json();
  if(!Array.isArray(j) || j.length !== 1) return { n: Array.isArray(j) ? j.length : 0 };
  const c = j[0].geometry && j[0].geometry.coordinates;
  if(!c) return { n: 1 };
  return { n: 1, lat: c[1], lng: c[0], title: (j[0].properties || {}).title || '' };
}

/* 本文に座標が無く、地名タグがあるとき、付けるべき座標タグを返す。
   本文そのものは変えない。足すかどうかは呼ぶ側が決める。 */
export async function locateText(text, cache, budget){
  const s = String(text || '');
  if(COORD_RE.test(s) || SEED_RE.test(s)) return null;   /* すでに座標がある */

  for(const name of townTags(s)){
    if(name in cache){
      const hit = cache[name];
      if(!hit) continue;                                 /* 空振りとして憶えている */
      return { name, tag: tagFor(hit.lat, hit.lng), lat: hit.lat, lng: hit.lng, cached: true };
    }
    if(budget.left <= 0) continue;                       /* 今回の照会枠を使い切った */
    budget.left--;

    let r;
    try { r = await ask(name); }
    catch(e){ console.error('[places]', name, e.message); continue; }
    await sleep(250);                                    /* 相手のサーバに間を置く */

    if(r.lat == null){
      cache[name] = null;                                /* 0件も多数件も、等しく空振り */
      console.log(`[places] ${name} は ${r.n} 件。採らない`);
      continue;
    }
    cache[name] = { lat: r.lat, lng: r.lng, title: r.title, at: new Date().toISOString() };
    return { name, tag: tagFor(r.lat, r.lng), lat: r.lat, lng: r.lng, cached: false };
  }
  return null;
}

/* ------------------------------------------------------------------ 逆引き --
   緯度経度 → 人が読める町名タグ。窓（tele.html）が投稿を組み立てるときに使う。

   国土地理院の逆ジオコーダは公開APIではない。予告なく変わりうる、と
   国土地理院自身が述べている。だから落ちても止まらない作りにする。
   名前が取れなければタグを一つ減らして送るだけで、場所の確定は符号がやる。 */

const REVERSE = 'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';
const MUNI_JS = 'https://maps.gsi.go.jp/js/muni.js';

let MUNI = null;

/* muni.js の表を一度だけ読む。
   キーは先頭のゼロが落ちている。旭川市は "01204" ではなく "1204"。
   ここを取り違えると市区町村名が空になり、町名だけのタグになって候補が爆発する。
   値は '1,北海道,1204,旭川市' の形。政令市は '京都市　下京区' と全角空白入り。 */
export async function muniTable(){
  if(MUNI) return MUNI;
  MUNI = {};
  try{
    const t = await (await fetch(MUNI_JS)).text();
    for(const m of t.matchAll(/MUNI_ARRAY\[\s*["'](\d+)["']\s*\]\s*=\s*['"]([^'"]*)['"]/g)){
      const p = m[2].split(',');
      MUNI[String(parseInt(m[1], 10))] = { pref: p[1] || '', city: (p[3] || '').replace(/\s+/g, '') };
    }
  }catch(e){ console.error('[places] muni.js', e.message); }
  return MUNI;
}

/* 政令指定都市は「京都市下京区」から「下京区」を取り出す。
   投稿の字数を惜しむため、まず区だけで試すため。 */
function wardOf(city){
  const m = /^(.+?市)(.+区)$/.exec(city || '');
  return m ? m[2] : (city || '');
}

/* 緯度経度 → { pref, city, ward, town }。海の上などでは null */
export async function nameAt(lat, lng){
  const r = await fetch(`${REVERSE}?lat=${lat}&lon=${lng}`);
  if(!r.ok) throw new Error('LonLatToAddress ' + r.status);
  const j = await r.json();
  const res = j && j.results;
  if(!res || !res.lv01Nm) return null;
  const tab = await muniTable();
  const e = tab[String(parseInt(res.muniCd, 10))] || { pref:'', city:'' };
  return { pref:e.pref, city:e.city, ward:wardOf(e.city), town:res.lv01Nm };
}

/* 一意に解ける、いちばん短い町名タグを返す。
   短い形から順に試し、候補が1件になった時点で止める。
   窓は「一意に解けることを確認した形」しか発行しない。
   推測はここ一箇所に閉じ込め、取り込み側は受け取った形をそのまま引くだけにする。 */
export async function tagAt(lat, lng){
  let n;
  try { n = await nameAt(lat, lng); }
  catch(e){ console.error('[places] nameAt', e.message); return null; }
  if(!n) return null;

  const tries = [
    n.ward + n.town,              /* 下京区朱雀宝蔵町 */
    n.city + n.town,              /* 京都市下京区朱雀宝蔵町 */
    n.pref + n.city + n.town      /* 京都府京都市下京区朱雀宝蔵町 */
  ].filter((v, i, a) => v && v !== n.town && a.indexOf(v) === i);

  for(const q of tries){
    let r;
    try { r = await ask(q); } catch(e){ continue; }
    if(r.n === 1) return { tag: '#' + q, name: q, lat: r.lat, lng: r.lng, town: n.town };
    await sleep(250);
  }
  return null;   /* 一意にできなかった。呼ぶ側は地点符号へ落とす */
}
