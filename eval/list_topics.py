"""Print document titles and H2 headings from the frozen corpus to help author eval queries."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "corpus_manifest.json").read_text(encoding="utf-8"))
HEADING_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)


def main() -> None:
    for doc in MANIFEST["documents"]:
        path = ROOT / "corpus" / doc["filename"]
        if not path.exists():
            print(f"{doc['doc_id']}: (missing — run python eval/fetch_corpus.py)")
            continue
        text = path.read_text(encoding="utf-8")
        headings = [h.replace("`", "") for h in HEADING_RE.findall(text)]
        preview = ", ".join(headings[:6])
        if len(headings) > 6:
            preview += f" (+{len(headings) - 6} more)"
        print(f"- {doc['doc_id']} ({doc['words']}w): {doc['title']} :: {preview}")


if __name__ == "__main__":
    main()
