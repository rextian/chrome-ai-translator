#!/usr/bin/env python3
"""检查代码引用的 i18n 键与语言包是否一致"""
import re
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

i18n = open(os.path.join(ROOT, 'lib/i18n.js'), encoding='utf-8').read()
zh_block = re.search(r"'zh-CN': \{(.*?)\n    \},", i18n, re.S).group(1)
en_block = re.search(r"'en': \{(.*?)\n    \}\n  \};", i18n, re.S).group(1)
zh_keys = set(re.findall(r"^\s*(\w+):", zh_block, re.M))
en_keys = set(re.findall(r"^\s*(\w+):", en_block, re.M))
print(f'语言包键数: zh={len(zh_keys)}, en={len(en_keys)}')
if zh_keys != en_keys:
    print('中英键不一致:', sorted(zh_keys ^ en_keys))

patterns = [
    re.compile(r"tr\(\s*(?:settings|null)?\s*,?\s*'(\w+)'"),
    re.compile(r"t\(\s*(?:lang\(\)|l)\s*,\s*'(\w+)'"),
    re.compile(r'tr\(\'(\w+)\''),
    re.compile(r'data-i18n="(\w+)"'),
    re.compile(r"detailKey:\s*'(\w+)'"),
]

used = set()
for root, dirs, files in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in ('.git', 'tools', '_locales')]
    for fn in files:
        if not fn.endswith(('.js', '.html')):
            continue
        s = open(os.path.join(root, fn), encoding='utf-8').read()
        for p in patterns:
            used |= set(p.findall(s))

print('代码引用键数:', len(used))
missing = sorted(k for k in used - zh_keys if k)
print('缺失键:', missing if missing else '无 ✓')
unused = sorted(zh_keys - used)
print('未使用键(可容忍):', unused)
