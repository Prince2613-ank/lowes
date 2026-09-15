"""Vercel serverless entry point.

Vercel's Python runtime looks for an ASGI-compatible `app` object in this
file. All static assets (frontend HTML/JS/CSS and the Lowes_*.geojson
files) are served directly by Vercel from `public/` instead of through
this function - see vercel.json's rewrites, which route only `/api/*`
here. Locally (uvicorn), backend/main.py still serves everything itself.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.main import app  # noqa: E402,F401
