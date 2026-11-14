import os
import sys

os.environ["LITEOFFICE_KB_DB"] = r"C:\deepseekharness\ai-lab\data\lab_kb.db"
sys.path.insert(0, r"C:\deepseekharness\ai-lab")

from app import kb

docs = kb.list_documents("lab")
for d in docs:
    print(f"{d['chunks']:3d} 块  {d['name'][:70]}")
print(f"总计 {len(docs)} 份 / {kb.kb_stats('lab')['chunks']} 块")
