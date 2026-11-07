#!/bin/sh
# Собирает папку dist/ для публикации (без тестов и личных квитанций) и архив kommunalka-dist.zip.
set -e
cd "$(dirname "$0")"
rm -rf dist kommunalka-dist.zip
mkdir dist
cp -R index.html styles.css manifest.webmanifest sw.js js icons vendor dist/
touch dist/.nojekyll  # GitHub Pages: отдавать файлы как есть, без обработки Jekyll
(cd dist && zip -qr ../kommunalka-dist.zip .)
echo "Готово: dist/ и kommunalka-dist.zip ($(du -sh dist | cut -f1))"
