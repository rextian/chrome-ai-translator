#!/usr/bin/env python3
"""多语言校验：所有语言包键集合两两一致 + 代码引用键全部存在"""
import re
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

i18n = open(os.path.join(ROOT, 'lib/i18n.js'), encoding='utf-8').read()

# 解析所有语言块（'xx-XX': { ... } 或 'xx': { ... }）
lang_blocks = re.findall(r"'([a-z]{2}(?:-[A-Z]{2})?)':\s*\{(.*?)\n    \}", i18n, re.S)
langs = {}
for code, block in lang_blocks:
    langs[code] = set(re.findall(r"^\s*(\w+):", block, re.M))

print('语言包:', ', '.join(f'{k}({len(v)})' for k, v in langs.items()))

base_code = 'zh-CN'
base_keys = langs.get(base_code, set())
all_ok = True
for code, keys in langs.items():
    if code == base_code:
        continue
    diff = base_keys ^ keys
    if diff:
        all_ok = False
        print(f'✗ {code} 与 {base_code} 不一致: {sorted(diff)}')
    else:
        print(f'✓ {code} 与 {base_code} 键集合一致')

# 代码引用键检查
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

missing = sorted(k for k in used - base_keys if k)
print(f'代码引用键数: {len(used)}，缺失: {missing if missing else "无 ✓"}')
if missing:
    all_ok = False

# _locales 目录与 messages.json 键
import json
locales_dir = os.path.join(ROOT, '_locales')
required_msg_keys = {'appName', 'appDesc', 'menuSelection', 'menuPage'}
for d in sorted(os.listdir(locales_dir)):
    p = os.path.join(locales_dir, d, 'messages.json')
    data = json.load(open(p, encoding='utf-8'))
    lack = required_msg_keys - set(data.keys())
    print(f'_locales/{d}: {"✓ 完整" if not lack else "✗ 缺 " + str(lack)}')
    if lack:
        all_ok = False

print('--- 全部通过 ---' if all_ok else '--- 存在问题 ---')
