/* ============================================================ profile.mjs ===
   名簿の欄を、外部回線の投稿から書く。

   これが要る理由はひとつ。
   「その番号がその人のものか」を確かめられるのは、投稿を拾う側だけである。
   受付（mayshare）は、目の前の人が @そのアカウント の持ち主かどうかを知らない。
   投稿はプラットフォームが本人確認を済ませたあとの発話なので、
   投稿に書かれた呼称は、その投稿者の番号にしか書き込めない。

   だから規則は一行で済む。
     **番号は本文から取らない。issueNumber が返した番号にだけ書く。**
   他人の番号を指名して書き換える経路が、そもそも存在しない。

   受け取る符（すべて任意・順不同・一行に混ぜてもよい）
     #呼称 ///ナツ
     #所見 ///夜の水路ばかり撮っています
     #区域 ///下京区
     #WIKIDOT ///natsu
     #合流 ///あさひ。ことり。むくち     受付で取った合流符。二度目以降の編集に使う
     #外部回線非表示                      SNS ハンドルを名簿に出さない
     #取り下げ                            名簿から自分の欄を消す（観測の記録は残る）

   書いたものは observers.json の profile に入り、盤にもフィルム片にも出ない。
   名簿（roster.html）だけが読む。
   ========================================================================= */

const CAP = { name: 12, note: 40, area: 12, wiki: 24, token: 60 };

/* 値は「///」「：」「:」のどれで始めてもよい。全角の ＃ も受ける。

   **符は行のはじめに書く。値は行の終わりまで。**
   この一行の約束が要るのは、そうしないと所見が観測の本文を飲み込むからである。
     #所見 ///夜の水路ばかり撮っています 今日も濡れていた
   これを途中からでも拾う作りにすると、「今日も濡れていた」が観測の言葉ではなく
   名簿の一行になり、盤から消える。拾えないほうがまだよい——本文は残り、
   書いた人はもう一度送り直せる。**取りこぼしは直せるが、消したものは戻らない。** */
/* 符の前に置けるのは「タグ」と「三語の鍵」だけ。ふつうの文のあとには置けない。
   ここが緩いと、観測の言葉が名簿の一行に吸い込まれる。
   逆にここが厳しすぎると、カード持ちの初投稿——名乗りの三語に続けて呼称を書く形——
   が拾えない。両方を満たす線がこれ。 */
const HEAD = '(?<=(?:^|\\n)[ \u3000]*(?:(?:[#＃]|///|／／／)[^\\s]{1,60}[ \u3000]+)*)';
const LINE = (names, cap) => new RegExp(
  HEAD + '[#＃](?:' + names.join('|') + ')[ \u3000]*(?:///|／／／|：|:)?[ \u3000]*([^\\n#＃]{1,' + cap + '})'
);
/* 合流符は三語ひとつづきなので、行のどこにあっても、空白までで切れば安全に拾える。 */
const ANY = (names, cap) => new RegExp(
  '[#＃](?:' + names.join('|') + ')[ \u3000]*(?:///|／／／|：|:)?[ \u3000]*([^\\s#＃]{1,' + cap + '})'
);

/* 一語で切れる欄は、本文の途中にあっても拾ってよい。
   切ったあとの言葉は本文へ返すので、観測の言葉は一文字も減らない。
   **所見だけは文なので、行のはじめに置かれたときしか拾わない。** */
const RE = {
  name : ANY(['呼称', '名前', 'なまえ'], 40),
  note : LINE(['所見', 'ひとこと', '一言'], 120),
  area : ANY(['区域', '担当区域'], 40),
  wiki : ANY(['WIKIDOT', 'Wikidot', 'wikidot', 'ウィキ'], 40),
  token: ANY(['合流符', '合流'], 80),
};
/* 呼称・区域・WIKIDOT は一語。空白のあとに続く言葉は観測の本文なので取らない。
   所見だけは文なので、空白を含んだまま行の終わりまで受ける。 */
const ONE_WORD = { name: true, area: true, wiki: true, token: true };
const HIDE_RE = /[#＃](?:外部回線非表示|SNS非表示|ハンドル非表示)/;
const DROP_RE = /[#＃](?:取り下げ|名簿から消す|削除)/;

/* 名簿の一行に、そのまま載る文字だけ残す。
   改行・制御文字・前後の空白を落とし、字数で切る。
   @ と URL は落とす（名簿にはハンドルの欄が別にある。二重に出さない）。 */
function clean(s, cap) {
  const t = String(s || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[@＠]\S+/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[ \u3000]+/g, ' ')
    .trim();
  return t ? Array.from(t).slice(0, cap).join('') : '';
}

/* 投稿から符を読み、**符そのものは本文から落とす**。
   落とさないと、呼称が観測の言葉として盤に載り、フィルム片に焼かれる。 */
export function readProfile(text) {
  const src = String(text || '');
  let rest = src;
  const fields = {};

  /* 出現順に一つずつ抜く。抜いたぶん文字列が詰まるので、
     「#観測センター #呼称 ///ナツ #所見 ///…」のようにタグが連なっていても、
     二つ目以降がちゃんと行のはじめに来る。 */
  for (let guard = 0; guard < 12; guard++) {
    let hit = null;
    for (const [k, re] of Object.entries(RE)) {
      if (fields[k] !== undefined) continue;
      const m = re.exec(rest);
      if (m && (!hit || m.index < hit.m.index)) hit = { k, m };
    }
    if (!hit) break;

    const { k, m } = hit;
    let raw = m[1], tail = '';              // 一語で切ったあとに残った言葉
    if (ONE_WORD[k]) {
      const sp = raw.search(/[ \u3000]/);
      if (sp > 0) { tail = raw.slice(sp); raw = raw.slice(0, sp); }
    }
    const v = clean(raw, CAP[k]);
    fields[k] = v || '';                    /* 空でも印を残す。同じ符で無限に回さないため */

    /* 符だけを抜き、残りの言葉は本文に返す。観測の言葉を落とさない */
    rest = rest.slice(0, m.index) + tail + rest.slice(m.index + m[0].length);
  }
  for (const k of Object.keys(fields)) if (fields[k] === '') delete fields[k];

  if (HIDE_RE.test(rest)) { fields.hideSns = true; rest = rest.replace(HIDE_RE, ' '); }
  if (DROP_RE.test(rest)) { fields.drop    = true; rest = rest.replace(DROP_RE, ' '); }

  const any = Object.keys(fields).length > 0;
  return { fields, rest: any ? rest.replace(/[ \u3000]{2,}/g, ' ') : src, any };
}

/* observers.profile に書く。
   ・番号は呼び出し側が issueNumber から受け取ったものだけ
   ・0000（名無し）と 0001〜0007（作中人物）には書かせない
   ・書いた時刻と出どころを残す。あとから受付が上書きしたかを判る形にする */
export function applyProfile(observers, num, prof, post, floor = 8) {
  if (!prof || !prof.any) return null;
  const v = parseInt(num, 10);
  if (!Number.isFinite(v) || v < floor) {
    console.log(`[名簿] ${num} は投稿からは書けません（作中の番号・名無しの番号）。`);
    return null;
  }
  observers.profile = observers.profile || {};
  const f = prof.fields;

  if (f.drop) {
    if (observers.profile[num]) {
      delete observers.profile[num];
      console.log(`[名簿] ${num} の欄を取り下げました（観測の記録は残ります）。`);
    }
    return { num, drop: true };
  }

  const cur = observers.profile[num] || {};
  const next = { ...cur };
  for (const k of ['name', 'note', 'area', 'wiki']) if (f[k]) next[k] = f[k];
  if (f.hideSns !== undefined) next.hideSns = !!f.hideSns;
  next.at  = post?.at || new Date().toISOString();
  next.src = post?.src || 'post';
  observers.profile[num] = next;

  const said = Object.keys(f).filter(k => k !== 'token').join('・');
  if (said) console.log(`[名簿] ${num} ${said} を受けました。`);
  return { num, fields: f };
}

/* 合流符の目撃記録。
   **ここでは正しさを判定しない。** 符が正しいかどうかを知っているのは受付だけで、
   このリポジトリに受付の秘密を持ち込むと、秘密が二か所に増える。
   機械は「この番号の持ち主が、この符を口にした」とだけ書き、受付が突き合わせる。
   だから GitHub と mayshare のあいだに共有の鍵は要らない。 */
export function noteAck(acks, num, prof, post, floor = 8) {
  const tok = prof?.fields?.token;
  if (!tok) return null;
  const v = parseInt(num, 10);
  if (!Number.isFinite(v) || v < floor) return null;

  acks[num] = {
    token : tok,
    handle: (post?.handle || '').toLowerCase().replace(/^@/, ''),
    src   : post?.src || null,
    at    : post?.at || new Date().toISOString(),
    seen  : new Date().toISOString(),
  };
  console.log(`[合流] ${num} が符を示しました。受付の突き合わせを待ちます。`);
  return acks[num];
}

/* 現地カードの鍵を、当て推量で探られないようにする。
   一回の投稿で試せるのは一番号につき一度、巡回は六時間に一度なので、
   53語×3＝148,877 通りを総当たりするのは現実的ではない。
   それでも、外れが続く番号は止めておく。止めたあとは運営が外す。 */
export function noteMiss(state, num, key, limit = 5) {
  state.keyMiss = state.keyMiss || {};
  const e = state.keyMiss[num] || { n: 0, seen: [] };
  const k = String(key || '').trim();
  if (k && !e.seen.includes(k)) { e.seen.push(k); e.n++; }
  state.keyMiss[num] = e;

  if (e.n >= limit && !(state.frozen || {})[num]) {
    state.frozen = state.frozen || {};
    state.frozen[num] = new Date().toISOString();
    console.log(`[名乗り] ${num} を凍結しました（外れが ${e.n} 回）。運営が state.json の frozen から外すまで通りません。`);
  }
  return e.n;
}
export const isFrozen = (state, num) => !!(state.frozen || {})[num];
