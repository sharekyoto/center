"""migrate_v4.py — 既存の記録票（record:*）を様式2 v4 に揃える、一度きりの移行

やること（本文の物語・経過・記述には一字も触れない）
  1. 追伸欄の案内から「Show Comments」「Wikidot にログインしていれば」を外し、
     外部回線（#観測センター）と受付の用紙の案内に差し替える
     （旧表記 #追伸UMK0000 @alembicity の一行も外す）
  2. [[module Comments ...]] の一行を外す（コメント欄での追伸はやめた）
  3. 照合（COLLATION）の欄が無い記録に、空欄の三行を足す（03 記述の手前に）。
     空欄は「待ち」。誰かの追伸で埋まる
  4. 先頭に [!-- 様式v4 --] の印を付け、二度目は何もしない

APPLY=1 のときだけ書く。無ければ差分をログに出すだけ（先に必ずこれで確かめる）。
必要な secrets：WIKIDOT_USER / WIKIDOT_PASSWORD（fateofether）
"""
import difflib, os, re, sys, time

APPLY = os.environ.get('APPLY') == '1'
ONLY = [x.strip().lower() for x in os.environ.get('ONLY', '').split(',') if x.strip()]
MARK = '[!-- 様式v4 --]'

NOTE_RE = re.compile(r'\[\[div class="rec-note"\]\]\n(?:(?!\[\[/div\]\]).)*?(?:Show Comments|ログインしていれば)(?:(?!\[\[/div\]\]).)*?\[\[/div\]\]', re.S)
OLDPS_RE = re.compile(r'\[\[div class="rec-note"\]\]\n外部回線から[^\n]*#追伸[^\n]*\n\[\[/div\]\]\n?')
COMMENTS_RE = re.compile(r'^\[\[module Comments[^\]]*\]\]\n?\n?', re.M)
SEC03_RE = re.compile(r'\[\[div class="rec-sec"\]\]\n\[\[div class="rec-sec-h"\]\]\n\[\[span class="rec-no"\]\]03')
SEC06_RE = re.compile(r'\[\[div class="rec-sec"\]\]\n\[\[div class="rec-sec-h"\]\]\n\[\[span class="rec-no"\]\]06')


def note(aid):
    return ('[[div class="rec-note"]]\n'
            f'この記録に言葉や写真を足すときは、元の投稿に返信するか、記録番号 @@{aid}@@ と #観測センター を添えて外部回線（X）に投稿してください。'
            f'[[[https://mayshare.chu.jp/center/form.html?ps={aid} | 受付の用紙]]] からも送れます。登録は要りません。\n'
            '届いた追伸は、6時間ごとの現像でこの下に並びます。\n'
            '[[/div]]')


COLLATION = '''[[div class="rec-sec"]]
[[div class="rec-sec-h"]]
[[span class="rec-no"]]02[[/span]] [[span class="rec-sec-t"]]COLLATION / 照合[[/span]]
[[/div]]

[[div class="rec-tbl"]]
||~ 照合 ||~ 記述 ||
|| THEN / かつて || @@かつて、ここは ＿＿＿ だった。@@ ||
|| NOW / いま || @@今、ここは ＿＿＿ である。@@ ||
|| GAP / 現象 || @@＿＿（一語）@@ ||
[[/div]]

[[div class="rec-note"]]
空いている行は、誰が埋めても構いません。追伸で送ってください。
[[/div]]
[[/div]]

'''


def transform(src, aid):
    if MARK in src:
        return src, []
    out, done = src, []
    out, n = NOTE_RE.subn(note(aid), out, count=1)
    if n: done.append('追伸の案内')
    out, n2 = OLDPS_RE.subn('', out)
    if n2 and not n: done.append('追伸の案内')
    out, n = COMMENTS_RE.subn('', out)
    if n: done.append('コメント欄')
    if 'COLLATION' not in out and 'THEN /' not in out:
        m = SEC03_RE.search(out) or SEC06_RE.search(out)
        if m:
            out = out[:m.start()] + COLLATION + out[m.start():]
            done.append('照合の三行')
    if not done:
        return src, []
    return MARK + '\n' + out, done


def main():
    user, pw = os.environ.get('WIKIDOT_USER'), os.environ.get('WIKIDOT_PASSWORD')
    if not user or not pw:
        print('[移行] WIKIDOT_USER / WIKIDOT_PASSWORD がありません'); sys.exit(1)
    import wikidot
    site = wikidot.Client(username=user, password=pw).site.get(os.environ.get('WIKIDOT_SITE', 'alembic'))
    pages = site.pages.search(category='record')
    print(f'[移行] record: {len(pages)} 頁 ／ {"書き込む" if APPLY else "差分だけ（APPLY=1 で書く）"}')
    summary = ['| 頁 | 変更 | 足した行 | 消した行（全部） |', '|---|---|---|---|']
    for p in pages:
        name = p.fullname
        if ONLY and name.split(':')[-1] not in ONLY:
            continue
        aid = name.split(':')[-1].upper()
        src = p.source.wiki_text
        new, done = transform(src, aid)
        if not done:
            print(f'  {name}: 変更なし'); continue
        print(f'  {name}: {"・".join(done)}')
        diff = list(difflib.unified_diff(src.splitlines(), new.splitlines(), lineterm='', n=0))
        gone = [l[1:] for l in diff if l.startswith('-') and not l.startswith('---')]
        added = sum(1 for l in diff if l.startswith('+') and not l.startswith('+++'))
        summary.append(f'| {name} | {"・".join(done)} | {added} | ' + ' ／ '.join(x.strip()[:60].replace('|', '｜') for x in gone if x.strip()) + ' |')
        if not APPLY:
            for line in diff:
                print('    ' + line)
            continue
        p.edit(source=new, comment='様式2 v4 に揃える（追伸の案内・照合の三行）')
        again = site.page.get(name)
        print('    →', '書きました' if MARK in again.source.wiki_text else '書けていません')
        time.sleep(3)
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a', encoding='utf-8') as f:
            f.write(('## 書き込み結果\n\n' if APPLY else '## 差分（まだ書いていません）\n\n') + '\n'.join(summary) + '\n')


if __name__ == '__main__':
    main()
