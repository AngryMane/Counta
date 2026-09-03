# vendor/ - OpenCV.js の配置

このフォルダには、アプリが読み込む OpenCV.js 本体（シングルスレッド版のWebAssemblyビルド）を配置します。
著作権の都合上、このリポジトリにはOpenCV.js本体を含めていません。以下の手順で入手し、配置してください。

## 配置するファイル

```text
vendor/opencv.js
```

ビルドによっては、Wasmバイナリが `opencv.js` にBase64として埋め込まれている場合と、
`opencv_js.wasm` として別ファイルになっている場合があります。別ファイル形式のビルドを使う場合は、
`opencv.js` と同じ `vendor/` フォルダに `opencv_js.wasm` も一緒に配置してください。

```text
vendor/opencv.js
vendor/opencv_js.wasm   (ビルドによっては不要)
```

## 入手方法（推奨: 公式ビルド済みファイル）

1. OpenCV公式サイトの OpenCV.js チュートリアルページを開きます。
   https://docs.opencv.org/4.x/d0/d84/tutorial_js_usage.html
2. ページ内で配布されている `opencv.js` をダウンロードします。
   このファイルは**シングルスレッド版**（`pthread`/SIMDマルチスレッドを使わない標準ビルド）です。
   GitHub PagesはCOOP/COEPヘッダーを自由に設定できないため、
   マルチスレッド版（`opencv_js.wasm` が `pthread` 前提でSharedArrayBufferを要求するビルド）は使用しないでください。
3. ダウンロードした `opencv.js`（および同梱されていれば `opencv_js.wasm`）を、このリポジトリの `vendor/` フォルダにそのまま置きます。

## 入手方法（自分でビルドする場合）

OpenCVのソースからEmscriptenでビルドする場合は、`build_js.py` を **マルチスレッドオプションを付けずに** 実行してください。

```bash
python ./platforms/js/build_js.py build_js --build_wasm
```

`--threads` や `--simd` を伴うビルドは、GitHub Pages上でSharedArrayBufferが利用できないため動作しません。
ビルドが完了すると `build_js/bin/opencv.js`（および場合により `opencv_js.wasm`）が生成されるので、
それを `vendor/opencv.js` としてこのフォルダにコピーしてください。

## 動作確認

1. `vendor/opencv.js` を配置したら、リポジトリのルートで簡易サーバーを起動します（README.md参照）。
2. ブラウザで `index.html` を開き、「画像処理機能を読み込んでいます...」の表示が消えて
   エラーバナーが出なければ、正しく読み込めています。
3. 読み込みに失敗する場合は、ブラウザの開発者ツールのコンソールで
   `vendor/opencv.js` への404エラーが出ていないか確認してください。

## ライセンス表記

OpenCV.jsは Apache License 2.0 で配布されています。
`vendor/opencv.js` を配置する際は、OpenCV公式サイトに記載のライセンス条文へのリンクを
README.mdやアプリのクレジット表示などに残すようにしてください（本リポジトリのREADME.mdにも記載しています）。
