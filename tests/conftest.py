"""Points the app at a throwaway SQLite file BEFORE anything imports config/db
(db.init_db() runs at import time), so tests never touch the real alphabot.db."""
import os
import tempfile

_tmpdir = tempfile.mkdtemp(prefix="alphabot-test-")
os.environ["ALPHABOT_DB"] = os.path.join(_tmpdir, "test.db")
