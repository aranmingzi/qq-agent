#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解压模型包，修正 GBK 编码的中文文件名。"""
import zipfile
import os
import sys

def extract_fixed(zip_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    z = zipfile.ZipFile(zip_path)
    count = 0
    for info in z.infolist():
        # zip 里的文件名是 cp437 解码的，实际是 GBK
        raw = info.filename
        try:
            name = raw.encode('cp437').decode('gbk')
        except (UnicodeEncodeError, UnicodeDecodeError):
            name = raw
        target = os.path.join(out_dir, name)
        if info.is_dir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with z.open(info) as src, open(target, 'wb') as dst:
            dst.write(src.read())
        count += 1
    return count

if __name__ == '__main__':
    pairs = [
        ('gpt-sovits-models/hutao-zh.zip', 'gpt-sovits-models/hutao'),
        ('gpt-sovits-models/nahida-zh.zip', 'gpt-sovits-models/nahida'),
        ('gpt-sovits-models/sparkle2.zip', 'gpt-sovits-models/sparkle'),
        ('diffsinger-hutao/nahida-diffsinger.zip', 'diffsinger-hutao'),
    ]
    for z, o in pairs:
        try:
            n = extract_fixed(z, o)
            print(f'{z} -> {o}: {n} 个文件')
        except Exception as e:
            print(f'{z} 失败: {e}')
