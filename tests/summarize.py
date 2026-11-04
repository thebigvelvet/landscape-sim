"""Print a test result file compactly: python tests/summarize.py tests/out-x.json"""
import json
import sys

R = json.load(open(sys.argv[1], encoding='utf-8'))
print(R.get('passed'), 'minutes', round(R.get('minutes', 0), 1), 'gpuErrors', R.get('gpuErrors'))
for k, v in R.get('checks', {}).items():
    print(('PASS ' if v['pass'] else 'FAIL ') + k, json.dumps({a: b for a, b in v.items() if a != 'pass'})[:700])
if 'runs' in R:
    print(json.dumps(R['runs'])[:1500])
