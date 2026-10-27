"""python grepdoc.py <doc> <regex> [ctx]: print each match in the snapshot with context."""
import re, sys
t = open(f'C:/Users/jsnov/repos/ai-triad-sources/{sys.argv[1]}/snapshot.md', encoding='utf-8').read()
ctx = int(sys.argv[3]) if len(sys.argv) > 3 else 200
for m in list(re.finditer(sys.argv[2], t, re.I))[:4]:
    print('...', t[max(0, m.start()-ctx):m.end()+ctx].replace('\n', ' '), '...\n')
