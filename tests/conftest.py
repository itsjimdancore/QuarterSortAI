import sys
from pathlib import Path

# Make `api.ocr` importable without adding api/__init__.py (Vercel would treat
# every .py file in api/ as a function).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
