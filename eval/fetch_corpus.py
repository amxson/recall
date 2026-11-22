"""Fetch and verify the frozen FastAPI tutorial docs corpus for Recall evaluation."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

REPO = "fastapi/fastapi"
TAG = "0.165.0"
COMMIT_SHA = "05e6df7e906c3decba377c37548019973f40bf15"
DOCS_PREFIX = "docs/en/docs/tutorial"

FILES = [
    "background-tasks.md",
    "bigger-applications.md",
    "body-fields.md",
    "body-multiple-params.md",
    "body-nested-models.md",
    "body-updates.md",
    "body.md",
    "cookie-param-models.md",
    "cookie-params.md",
    "cors.md",
    "debugging.md",
    "encoder.md",
    "extra-data-types.md",
    "extra-models.md",
    "first-steps.md",
    "frontend.md",
    "handling-errors.md",
    "header-param-models.md",
    "header-params.md",
    "index.md",
    "metadata.md",
    "middleware.md",
    "path-operation-configuration.md",
    "path-params-numeric-validations.md",
    "path-params.md",
    "query-param-models.md",
    "query-params-str-validations.md",
    "query-params.md",
    "request-files.md",
    "request-form-models.md",
    "request-forms-and-files.md",
    "request-forms.md",
    "response-model.md",
    "response-status-code.md",
    "schema-extra-example.md",
    "server-sent-events.md",
    "sql-databases.md",
    "static-files.md",
    "stream-json-lines.md",
    "testing.md",
]

ROOT = Path(__file__).resolve().parent
CORPUS_DIR = ROOT / "corpus"
MANIFEST_PATH = ROOT / "corpus_manifest.json"

INCLUDE_RE = re.compile(r"\{\*.*?\*\}", re.DOTALL)
ADMONITION_RE = re.compile(r"^///\s*(?:tip|note|info|warning|danger|details|check|tab).*$", re.MULTILINE)
CLOSING_FENCE_RE = re.compile(r"^///\s*$", re.MULTILINE)
HEADING_ANCHOR_RE = re.compile(r"^(#{1,6}\s+.+?)\s*\{\s*#[^}]+\s*\}\s*$", re.MULTILINE)
H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


def canonical_url(filename: str) -> str:
    slug = filename.removesuffix(".md")
    if slug == "index":
        return "https://fastapi.tiangolo.com/tutorial/"
    return f"https://fastapi.tiangolo.com/tutorial/{slug}/"


def clean_markdown(raw: str) -> str:
    # Strip MkDocs snippet includes, heading anchor attributes, and admonition markers
    text = INCLUDE_RE.sub("", raw)
    text = HEADING_ANCHOR_RE.sub(r"\1", text)
    text = ADMONITION_RE.sub("", text)
    text = CLOSING_FENCE_RE.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def extract_title(text: str, filename: str) -> str:
    match = H1_RE.search(text)
    if match:
        return match.group(1).strip().replace("{ #", "").split("}")[0].strip()
    return filename.removesuffix(".md").replace("-", " ").title()


def fetch_file(filename: str) -> bytes:
    url = f"https://raw.githubusercontent.com/{REPO}/{COMMIT_SHA}/{DOCS_PREFIX}/{filename}"
    req = urllib.request.Request(url, headers={"User-Agent": "recall-corpus-fetcher/0.1"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def main() -> int:
    CORPUS_DIR.mkdir(parents=True, exist_ok=True)
    documents = []

    for idx, filename in enumerate(FILES, start=1):
        raw_bytes = fetch_file(filename)
        cleaned = clean_markdown(raw_bytes.decode("utf-8"))
        out_path = CORPUS_DIR / filename
        out_path.write_text(cleaned, encoding="utf-8")

        digest = hashlib.sha256(cleaned.encode("utf-8")).hexdigest()
        doc_id = filename.removesuffix(".md")
        title = extract_title(cleaned, filename)
        word_count = len(cleaned.split())

        documents.append(
            {
                "doc_id": doc_id,
                "filename": filename,
                "title": title,
                "url": canonical_url(filename),
                "sha256": digest,
                "bytes": len(cleaned.encode("utf-8")),
                "words": word_count,
            }
        )
        print(f"[{idx:02d}/{len(FILES)}] {filename} ({word_count} words)")

    manifest = {
        "source_repo": REPO,
        "tag": TAG,
        "commit_sha": COMMIT_SHA,
        "docs_prefix": DOCS_PREFIX,
        "document_count": len(documents),
        "total_words": sum(d["words"] for d in documents),
        "documents": documents,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote manifest: {MANIFEST_PATH} ({manifest['document_count']} docs, {manifest['total_words']} words)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
