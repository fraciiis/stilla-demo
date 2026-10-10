#!/usr/bin/env python3
"""Stilla · punto di avvio.  python3 app.py  (oppure i file run_*.bat / .command / .sh)"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from um.server import main  # noqa: E402
from um.wsgi import app  # noqa: E402,F401  (WSGI per i servizi online che cercano `app`)

if __name__ == "__main__":
    sys.exit(main())
