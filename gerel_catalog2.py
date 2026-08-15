#!/usr/bin/env python3
"""
Gerel — catalogue builder
=========================

Reads the EPUB files you have already downloaded and writes a clean
catalog.json for the library app.

The website's own listing turned out to be thin: every book came back under a
single category, and the author fields were empty. The books themselves carry
better information, so this reads the metadata straight out of each file.

    python gerel_catalog.py books/
    python gerel_catalog.py books/ --categories categories.json

The optional categories file maps a book's file name to one or more shelf
names, so a children's shelf can be separated from the rest. Without it every
book lands on one shelf and you can sort them later.

Also reports the character count per book, which is what Azure charges on,
so the cost of voicing the library is visible before any of it is spent.
"""

import argparse
import json
import os
import re
import sys
import zipfile
from html import unescape
from xml.etree import ElementTree as ET

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

OPF_NS = {"opf": "http://www.idpf.org/2007/opf",
          "dc": "http://purl.org/dc/elements/1.1/"}

# Same rules the app uses, so the character count reflects what will really
# be narrated rather than including the advertising we strip out.
PROMO_MARKERS = ["bolorsoft", "болор дуран", "сурталчилгаа", "программтай танилцах",
                 "хандив", "хаан банк", "qpay", "e-nom.mn", "үнэ төлбөр"]
CREDIT_MARKERS = ["e-nom.mn", "цахим номын сан", "хөрвүүлэв",
                  "эрхлэн хэвлүүлсэн", "хэвлэлийн газар"]
SEPARATOR = re.compile(r"^[⁂*※•\s]+$")


def marker_hits(text, words):
    low = text.lower()
    return sum(1 for w in words if w in low)


def paragraphs_of(html):
    body = re.sub(r"(?is)^.*?<body[^>]*>", "", html)
    found = re.findall(r"(?is)<(?:p|h1|h2|h3|h4|li|blockquote)[^>]*>(.*?)</(?:p|h1|h2|h3|h4|li|blockquote)>", body)
    out = []
    for chunk in found:
        t = unescape(re.sub(r"<[^>]+>", " ", chunk))
        t = re.sub(r"\s+", " ", t).strip()
        if t:
            out.append(t)
    return out


def strip_trailing_promo(paras):
    for i, p in enumerate(paras):
        if not SEPARATOR.match(p):
            continue
        if marker_hits(" ".join(paras[i:]), PROMO_MARKERS) >= 2:
            return paras[:i]
    return paras


def read_epub(path):
    """Pull title, author and narratable character count out of one EPUB."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()

        container = z.read("META-INF/container.xml").decode("utf-8", "replace")
        opf_path = re.search(r'full-path="([^"]+)"', container).group(1)
        opf_dir = opf_path.rsplit("/", 1)[0] + "/" if "/" in opf_path else ""

        root = ET.fromstring(z.read(opf_path))
        title = root.findtext(".//dc:title", default="", namespaces=OPF_NS).strip()
        author = root.findtext(".//dc:creator", default="", namespaces=OPF_NS).strip()

        items = {i.get("id"): i.get("href")
                 for i in root.findall(".//opf:manifest/opf:item", OPF_NS)}
        spine = [items.get(r.get("idref"))
                 for r in root.findall(".//opf:spine/opf:itemref", OPF_NS)]
        spine = [h for h in spine if h]

        chars = 0
        sections = 0
        ads = 0
        for href in spine:
            for candidate in (opf_dir + href, href):
                if candidate in names:
                    raw = z.read(candidate).decode("utf-8", "replace")
                    break
            else:
                continue

            paras = paragraphs_of(raw)
            if not paras:
                continue
            whole = " ".join(paras)

            if len(whole) < 800 and marker_hits(whole, PROMO_MARKERS) >= 2:
                ads += 1
                continue
            if len(whole) < 1500 and marker_hits(whole, CREDIT_MARKERS) >= 2:
                continue

            before = len(paras)
            paras = strip_trailing_promo(paras)
            if len(paras) < before:
                ads += 1
            paras = [p for p in paras if len(p) > 1]
            if not paras:
                continue

            sections += 1
            chars += sum(len(p) for p in paras)

    return {"title": title, "author": author, "chars": chars,
            "sections": sections, "ads_removed": ads}


def norm_title(t):
    """Match titles loosely: case, punctuation and spacing differ between the
    website's listing and the book's own metadata."""
    t = (t or "").lower().replace("ё", "е")
    t = re.sub(r"[^0-9a-zа-яөү]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


# Files are named like  TITLE_-_AUTHOR.epub
FILENAME_SPLIT = re.compile(r"^(.*?)_-_(.*)$")


def from_filename(stem):
    m = FILENAME_SPLIT.match(stem)
    if not m:
        return stem.replace("_", " ").strip(), ""
    title, author = m.group(1), m.group(2)
    return title.replace("_", " ").strip(), author.replace("_", " ").replace(".", ". ").strip()


def main():
    print("[gerel_catalog2 — title matching]")
    ap = argparse.ArgumentParser(description="Build catalog.json from downloaded EPUBs.")
    ap.add_argument("folder", help="folder holding the .epub files")
    ap.add_argument("--categories", help="JSON mapping filename -> [source category names]")
    ap.add_argument("--shelves", help="shelves.json — Gerel's own shelf structure")
    ap.add_argument("--children-only", action="store_true",
                    help="keep only the children's shelves. Adult titles are left out of "
                         "the catalogue entirely rather than merely hidden, so nothing "
                         "unsuitable ships with a children's library.")
    ap.add_argument("--out", default="catalog.json")
    ap.add_argument("--credit", default="Номуудыг «Цогт охин тэнгэр» сангийн "
                                        "Цахим номын сангаас зөвшөөрөлтэйгээр авав. e-nom.mn")
    args = ap.parse_args()

    by_title, by_file = {}, {}
    if args.categories and os.path.exists(args.categories):
        with open(args.categories, encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict) and "books" in loaded:
            for rec in loaded["books"]:
                by_title[norm_title(rec.get("title"))] = rec.get("categories", [])
        else:
            by_file = loaded          # older filename-keyed file still works

    # Gerel's own shelves. The source library has 52 categories, which is far
    # more than a child can listen through, so several fold into one shelf and
    # the children's shelves come first.
    shelf_of_source = {}
    shelf_order = []
    child_shelves = set()
    fallback = "Бусад"
    if args.shelves and os.path.exists(args.shelves):
        with open(args.shelves, encoding="utf-8") as f:
            cfg = json.load(f)
        fallback = cfg.get("fallback", fallback)
        for shelf in cfg.get("shelves", []):
            shelf_order.append(shelf["name"])
            if shelf.get("forChildren"):
                child_shelves.add(shelf["name"])
            for source in shelf.get("from", []):
                shelf_of_source[source.strip().lower()] = shelf["name"]

    def shelves_for(fname, stem, title):
        sources = (by_title.get(norm_title(title))
                   or by_file.get(fname) or by_file.get(stem) or [])
        out = []
        for src in sources:
            name = shelf_of_source.get(src.strip().lower(), src if not shelf_order else fallback)
            if name not in out:
                out.append(name)
        return out or [fallback]

    files = sorted(f for f in os.listdir(args.folder) if f.lower().endswith(".epub"))
    print(f"{len(files)} EPUB files found in {args.folder}\n")

    shelves = {}
    total_chars = 0
    unmatched = 0
    failed = []

    for i, name in enumerate(files, 1):
        path = os.path.join(args.folder, name)
        stem = os.path.splitext(name)[0]
        fallback_title, fallback_author = from_filename(stem)
        try:
            info = read_epub(path)
        except Exception as e:
            failed.append((name, str(e)))
            print(f"[{i}/{len(files)}] FAILED {name}: {e}")
            continue

        title = info["title"] or fallback_title
        author = info["author"] or fallback_author
        # Some files carry a placeholder author from the conversion tool.
        if author.lower() in ("неизвестный", "unknown", "unknown author"):
            author = fallback_author

        entry = {
            "title": title,
            "author": author,
            "file": "books/" + name,
            "chars": info["chars"],
            "minutes": round(info["chars"] / 5 / 150),   # ~150 words a minute
        }
        total_chars += info["chars"]

        found = shelves_for(name, stem, title)
        if found == [fallback]:
            unmatched += 1
        for shelf in found:
            shelves.setdefault(shelf, []).append(entry)

        if i % 50 == 0 or i == len(files):
            print(f"[{i}/{len(files)}] read…")

    # Children's shelves first, then the rest in the order the config gives,
    # then anything unexpected, then the fallback.
    def rank(name):
        if name in shelf_order:
            return (0 if name in child_shelves else 1, shelf_order.index(name))
        return (2 if name != fallback else 3, 0)

    if args.children_only:
        for name in [k for k in shelves if k not in child_shelves]:
            del shelves[name]

    catalog = {
        "credit": args.credit,
        "shelves": [{"name": k,
                     "forChildren": k in child_shelves,
                     "books": sorted(v, key=lambda b: b["title"])}
                    for k in sorted(shelves, key=rank)
                    for v in [shelves[k]]]
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    print(f"\nWrote {args.out}")
    unique = len({b["file"] for sh in catalog["shelves"] for b in sh["books"]})
    print(f"  books        : {unique}" + ("  (children only)" if args.children_only else ""))
    print(f"  shelves      : {len(catalog['shelves'])}")
    print()
    for sh in catalog["shelves"]:
        tag = "  (children)" if sh["forChildren"] else ""
        print(f"    {len(sh['books']):5d}  {sh['name']}{tag}")
    print()
    print(f"  characters   : {total_chars:,}")
    print(f"  listening    : about {total_chars/5/150/60:,.0f} hours")
    print(f"  voicing cost : about ${total_chars/1_000_000*16:,.0f} if every book were narrated")
    print(f"                 (generate on first listen instead and you pay only for what is read)")
    if unmatched:
        print(f"\n  {unmatched} books found no category and went to \"{fallback}\".")
    if failed:
        print(f"\n  {len(failed)} files could not be read:")
        for n, e in failed[:10]:
            print(f"    {n}: {e}")


if __name__ == "__main__":
    main()
