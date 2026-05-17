#!/bin/bash
# Copy files from original location
SRC="$HOME/.gemini/antigravity/scratch/ice-facture-maroc"
DST="$HOME/Documents/New project/ice-facture-maroc"

echo "📂 Copying missing files..."
for f in style.css index.html app.js; do
  cp "$SRC/$f" "$DST/$f" && echo "  ✅ $f" || echo "  ❌ $f failed"
done

cd "$DST"

# Init git and push
git init
git add -A
git commit -m "IceMar - Recherche ICE, Facture Conforme & Outils Société"
git branch -M main
git remote add origin https://github.com/AmineR0/icemar.com.git
git push -u origin main

echo "🚀 Done!"
