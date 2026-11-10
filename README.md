# seosynth — ブラウザで動くウェーブテーブルシンセ

Rust で書いたシンセエンジンを WebAssembly にして、ブラウザの AudioWorklet で鳴らすウェーブテーブルシンセサイザーです。インストール不要で、作った音色は URL で共有できます。

*A wavetable synthesizer whose DSP engine is written in Rust, compiled to WebAssembly and run in an AudioWorklet. Nothing to install, and every sound can be shared as a link. [English summary below](#english).*

![seosynth の画面](docs/screenshot.png)

## 特長

**音の流れが見える UI**

- 画面がそのままシグナルチェインになっています：`音のもと → フィルター → アンプ → エフェクト → 出力`
- モジュール同士はケーブルで結ばれ、音が流れている経路が光ります。各モジュールの右上には「そこから出ていく音」の波形が出るので、フィルターやエフェクトが音をどう変えたかを見比べられます
- オシレーターごとに「フィルターを通す／迂回する」を切り替えると、ケーブルの経路も変わります
- エフェクトは行をドラッグして順番を入れ替えられます
- エンベロープや LFO は下段の「動かす」レーンにあり、色付きの ● をつまみにドラッグすると配線されます。つながりは線で表示され、つまみの周りに動く範囲と現在値が出ます
- つまみにマウスを乗せると、何をするものかが画面下に日本語で表示されます。はじめての人向けのガイド（8 ステップ）つき
- 日本語／英語の切り替え

**シンセとしての機能（SERUM を参考にした構成）**

| | |
|---|---|
| オシレーター | ウェーブテーブル ×2（22 種類のテーブル、WT 位置のモーフィング、ユニゾン最大 16 声、ワープ 13 種：Sync / Bend / PWM / Asym / Flip / Mirror / Quantize / FM / AM / RM）、サブ、ノイズ |
| フィルター | 19 種類（LP / HP / BP / ノッチ / ピーク / ラダー / モーフ / コム / フェイザー / フォルマント ほか）、ドライブ、キー追従、ステレオ |
| モジュレーション | エンベロープ ×3（AHDSR＋カーブ）、LFO ×4（プリセット波形または自分で描く、テンポ同期）、マクロ ×4、ベロシティ／ノート／MOD ホイールなど。32 スロットのマトリクス |
| エフェクト | ハイパー／ディメンション、ディストーション、フランジャー、フェイザー、コーラス、ディレイ、コンプレッサー、リバーブ、EQ、フィルター（並べ替え可能） |
| 演奏 | 画面の鍵盤、PC キーボード、MIDI キーボード（Web MIDI）、デモ演奏、ポリ 16 声／モノ／レガート／グライド |

**共有と書き出し**

- **URL で共有**：音色の設定はすべて URL の `#p=…` の中に入ります。サーバーには何も保存しません。アドレスバーの URL は編集のたびに更新されるので、そのままコピーしても共有できます
- **プリセットファイル**：読みやすい JSON（`.seosynth.json`）で保存・読み込み
- **Serum 2 用の書き出し**：`.SerumPreset` と、必要なウェーブテーブルの WAV を書き出します（[下記の注意](#serum-2-への書き出しについて)を読んでください）

## 動かす

必要なもの：Rust（`wasm32-unknown-unknown` ターゲット）と Node.js 20 以上。npm パッケージのインストールは不要です。

```sh
rustup target add wasm32-unknown-unknown   # 初回のみ
npm run build                              # Rust → web/wasm/seosynth.wasm
npm run dev                                # http://localhost:8080
```

`web/` フォルダは、ビルドした `seosynth.wasm` を含めれば、そのまま静的サイトとして配信できます。

### テスト

```sh
npm test
```

Rust のユニットテスト（DSP・パッチ形式・Serum 書き出し）と、ビルドした wasm を Node から動かすテスト（プリセット全件の読み込みと発音、共有 URL の往復、書き出したファイルの読み戻し）を実行します。

## 構成

```
engine/            Rust のシンセエンジン（依存クレートなし）
  src/params.rs      全パラメータの表（キー・範囲・単位・安定 ID）
  src/wavetable.rs   帯域制限つきウェーブテーブル（ミップマップ）
  src/tables.rs      内蔵ウェーブテーブルの生成
  src/osc.rs         ウェーブテーブルオシレーター（ユニゾン・ワープ）
  src/filter.rs      フィルター
  src/env.rs lfo.rs  エンベロープ、LFO
  src/voice.rs       1 ボイス：音源 → フィルター → アンプ
  src/fx/            エフェクト
  src/synth.rs       ボイス管理、モジュレーション、UI 用のタップ／テレメトリ
  src/patch.rs       パッチと共有用バイナリ形式
  src/serum/         Serum 2 プリセットの書き出し
  src/api.rs         WebAssembly の公開関数
web/               Web アプリ（ビルド不要の ES モジュール）
  js/engine/         wasm のラッパー、AudioWorklet
  js/store.js        パッチの状態管理（undo、JSON、URL）
  js/ui/             画面
  js/presets.js      内蔵プリセット
tests/             Node から wasm と Web 側モジュールを検証
```

エンジンの wasm はブラウザ内で 2 つインスタンス化されます。1 つは AudioWorklet（音声スレッド）で音を出し、もう 1 つはメインスレッドでパッチの正本を持ち、波形やフィルター特性のプレビューを描くのに使います。エンジンは `extern "C"` の素の関数だけを公開しているので、JS のグルーコードなしで AudioWorklet の中から読み込めます。

### 共有 URL の形式

パッチは「初期値と違うものだけ」をコンパクトなバイナリにし、base64url で URL のフラグメントに入れます（プリセットで 150〜300 文字程度）。パラメータは変更されない「安定 ID」で記録するので、あとからパラメータを追加しても古い URL は開けます。詳細は `engine/src/patch.rs` の冒頭にあります。

## Serum 2 への書き出しについて

- `.SerumPreset` は **公開されていない形式** です。コミュニティによる解析（下記）をもとに、ヘッダー＋JSON メタデータ＋Zstandard 圧縮した CBOR という構造で書き出しています
- 書き出したファイルは、別実装の zstd／CBOR デコーダーで読み戻し、Serum 2 の初期プリセットとモジュール構成が一致することを確認しています。ただし **Serum 2 本体での読み込みは未確認** です（開発環境に Serum がないため）。読み込めない場合は Issue で教えてください
- seosynth と Serum は別のシンセなので、同じ音にはなりません。つまみの位置、配線、エフェクトの順番を移し替えるものです。移し替えられなかった項目は、書き出しダイアログの「変換メモ」に表示されます
- Serum はウェーブテーブルを自分のフォルダから読み込むため、テーブルは WAV として別に書き出します。`Serum 2 Presets/Tables/seosynth/` に置いてください（ZIP にまとめてダウンロードできます）

形式の調査で参考にしたもの：

- [KennethWussmann/serum-preset-packager](https://github.com/KennethWussmann/serum-preset-packager)（コンテナ形式）
- [btesser/serum2vital](https://github.com/btesser/serum2vital) のドキュメント（パラメータの単位、エフェクト、モジュレーション元の ID）
- [ThatMajd/PySerum](https://github.com/ThatMajd/PySerum)（モジュレーション先の ID）

Serum は Xfer Records の製品です。このプロジェクトは Xfer Records とは関係ありません。

## GitHub に上げる／公開する

```sh
gh repo create seosynth --source . --public --push   # または git remote add … && git push
```

`.github/workflows/` に 2 つのワークフローが入っています。

- `test.yml`：push と Pull Request でテストを実行
- `pages.yml`：`main` への push で wasm をビルドし、`web/` を GitHub Pages に公開。リポジトリの Settings → Pages → Source を「GitHub Actions」にすると有効になります

## 今後のアイデア

- ウェーブテーブルエディター（自分で描く、音声ファイルから取り込む）
- オシレーターのオーバーサンプリング（ワープを強くかけたときのエイリアシング低減）
- Serum 2 本体での書き出し検証と、未対応項目（Env／LFO／FX を行き先にした配線など）の対応

ライセンス：[MIT](LICENSE)

---

<a id="english"></a>

## English

seosynth is a wavetable synthesizer for the browser. The DSP engine is dependency-free Rust compiled to WebAssembly and runs in an AudioWorklet; the UI is plain ES modules with no build step.

- **The screen is the signal chain.** Sources, filter, amp, effects and output are joined by cables that light up with the sound passing through, and every module shows a small scope of what leaves it. Modulation sources live in their own lane; drag a coloured dot onto a knob to connect it. Hover any control for a plain-language explanation; a guided tour covers the first steps. Japanese and English.
- **Synth features** modelled on Serum's layout: two wavetable oscillators (22 generated tables, unison, 13 warp modes), sub, noise, a 19-type filter, 3 envelopes, 4 LFOs with drawable shapes, 4 macros, a 32-slot mod matrix and ten reorderable effects.
- **Sharing.** The whole patch is encoded into the URL fragment, so a link is the preset. Presets can also be saved as JSON.
- **Serum 2 export.** Writes a `.SerumPreset` plus the wavetables as WAV. The format is unpublished and the export follows community reverse-engineering; files round-trip through independent decoders and match the structure of a real init preset, but loading in Serum 2 itself has not been verified yet. It is a translation of settings, not a clone of the sound.

```sh
rustup target add wasm32-unknown-unknown
npm run build && npm run dev    # http://localhost:8080
npm test
```

License: [MIT](LICENSE).
