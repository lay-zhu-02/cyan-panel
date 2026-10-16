"""Import a directory of Wallpaper Engine projects without a running web app."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from theme_engine import Library

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('--library', type=Path, required=True)
args = parser.parse_args()
results = Library(args.library).import_tree(args.source)
print(json.dumps(results, ensure_ascii=False, indent=2))
