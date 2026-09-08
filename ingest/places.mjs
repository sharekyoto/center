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
