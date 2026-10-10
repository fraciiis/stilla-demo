"""Punto d'ingresso per Vercel: espone l'app come WSGI (`app`). In locale si usa invece `python3 app.py`."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from um.wsgi import app  # noqa: E402,F401
