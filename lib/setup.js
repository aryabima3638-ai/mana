// Auto setup GitHub: bot membuat / memperbarui file workflow di repo lewat API (tanpa upload manual)
const S = require('../setting');
const gh = require('./github');

// "§" diganti "$" supaya tidak bentrok dengan template literal JS
const fix = (x) => x.replace(/§/g, '$');

const CHAIN = () => (S.flutterChain && S.flutterChain.length ? S.flutterChain : [{ label: 'Terbaru', value: '' }]);

// Error yang kemungkinan besar karena versi Flutter/Gradle/AGP tidak cocok -> coba Flutter berikutnya
const VERSIONISH = "minimum supported version|No named parameter|isn.t defined|is not defined|Undefined (name|class|method)|The (getter|method|named parameter)|Dart SDK|SDK version|version solving|requires Flutter|Unsupported (class file|Gradle|Kotlin)|Android Gradle Plugin|incompatible|Kotlin.*version|NoSuchMethod|compileSdk";

// Ekstrak ZIP/TGZ/7Z/RAR berdasarkan isi file (bukan nama)
const EXTRACT = `
          mkdir -p source
          gh release download "§{{ inputs.tag }}" --repo §{{ github.repository }} --pattern "source.*" --dir source
          cd source
          F=$(ls source.* | head -1)
          MAGIC=$(head -c 4 "$F" | od -An -tx1 | tr -d ' \\n')
          case "$MAGIC" in
            504b*) unzip -q -o "$F" || 7z x -y "$F" > /dev/null ;;
            1f8b*) tar xzf "$F" ;;
            377abcaf) 7z x -y "$F" > /dev/null ;;
            52617221) 7z x -y "$F" > /dev/null 2>&1 || bsdtar -xf "$F" 2>/dev/null || { sudo apt-get install -y -qq unrar-free > /dev/null 2>&1; unrar-free -x "$F" . > /dev/null; } ;;
            *) tar xf "$F" ;;
          esac
          rm -f "$F"`;

const FIND_ROOT = `${EXTRACT}
          # pilih pubspec project Flutter yang paling cocok (utamakan yang punya sdk: flutter + folder android/web)
          ALL=$(find . -name pubspec.yaml -not -path '*/__MACOSX/*' -not -path '*/.dart_tool/*' -not -path '*/ephemeral/*' -not -path '*/example/*' -not -path '*/.symlinks/*' -not -path '*/node_modules/*' -not -path '*/.pub-cache/*' | awk '{print length, $0}' | sort -n | cut -d' ' -f2- || true)
          PUB=""
          for f in $ALL; do d=$(dirname "$f"); if grep -qE 'sdk:[[:space:]]*flutter' "$f" && { [ -d "$d/android" ] || [ -d "$d/web" ]; }; then PUB="$f"; break; fi; done
          if [ -z "$PUB" ]; then for f in $ALL; do if grep -qE 'sdk:[[:space:]]*flutter' "$f"; then PUB="$f"; break; fi; done; fi
          [ -z "$PUB" ] && PUB=$(echo "$ALL" | head -1)
          if [ -z "$PUB" ]; then
            echo "Isi ZIP (3 level teratas):"
            find . -maxdepth 3 | head -60 || true
            echo "::error::pubspec.yaml tidak ditemukan di dalam ZIP. Zip folder project Flutter yang ada pubspec.yaml."
            exit 1
          fi
          ROOT=$(cd "$(dirname "$PUB")" && pwd)
          echo "PROJECT_ROOT=$ROOT" >> "$GITHUB_ENV"
          echo "Project root: $ROOT"`;

// Perbaiki kekurangan umum pada base: aset/.env hilang, key.properties hilang
const PREP = String.raw`          cd "$PROJECT_ROOT"
          # aset (folder / .env) yang dideklarasi di pubspec tetapi tidak ada -> dibuat kosong supaya build tidak gagal
          awk '/^flutter:/{f=1;next} f&&/^[^ #]/{f=0} f' pubspec.yaml | grep -E '^[[:space:]]+-[[:space:]]+[^ ]' | sed -E 's/^[[:space:]]+-[[:space:]]+//; s/[[:space:]]+#.*//' | tr -d "\"'" | while read -r A; do
            case "$A" in
              */) [ -d "$A" ] || { mkdir -p "$A"; touch "$A/.gitkeep"; echo "::warning::Folder aset $A tidak ada, dibuat kosong"; } ;;
              *.env|.env*|*/.env*) [ -f "$A" ] || { mkdir -p "$(dirname "$A")"; touch "$A"; echo "::warning::File $A tidak ada, dibuat kosong"; } ;;
              *.*) [ -e "$A" ] || { mkdir -p "$(dirname "$A")"; touch "$A"; echo "::warning::Aset $A tidak ada di ZIP, dibuat kosong (gambar/file ini akan kosong di app)"; } ;;
            esac
          done
          # hapus file build lama dari ZIP agar tidak bentrok
          rm -rf build .dart_tool android/.gradle android/app/build ios/Pods 2>/dev/null || true
          # signing release: key.properties dirujuk tetapi tidak ada -> buat keystore sementara
          if grep -qs 'key.properties' android/app/build.gradle android/app/build.gradle.kts && [ ! -f android/key.properties ]; then
            keytool -genkeypair -keystore /tmp/upload.jks -storepass android -keypass android -alias key -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Build" > /dev/null 2>&1 || true
            {
              echo "storePassword=android"
              echo "keyPassword=android"
              echo "keyAlias=key"
              echo "storeFile=/tmp/upload.jks"
            } > android/key.properties
            echo "::notice::key.properties tidak ada, dibuat otomatis (keystore sementara)"
          fi
          # androidx wajib untuk plugin Flutter modern; base lama sering belum migrasi
          if [ -d android ]; then
            if [ -f android/gradle.properties ]; then
              grep -q '^android.useAndroidX=' android/gradle.properties || echo 'android.useAndroidX=true' >> android/gradle.properties
              grep -q '^android.enableJetifier=' android/gradle.properties || echo 'android.enableJetifier=true' >> android/gradle.properties
            else
              { echo 'android.useAndroidX=true'; echo 'android.enableJetifier=true'; } > android/gradle.properties
            fi
            [ -f android/local.properties ] || [ -z "$ANDROID_HOME" ] || echo "sdk.dir=$ANDROID_HOME" > android/local.properties
          fi`;

const FIXMS = String.raw`          cat > /tmp/fixminsdk.py <<'PY'
          import re, glob, os
          t = int(os.environ['MS'])
          files = glob.glob('android/app/build.gradle') + glob.glob('android/app/build.gradle.kts')
          rx = re.compile(r'(minSdk(?:Version)?)(\s*=?\s*)(\d+|flutter\.minSdkVersion)')
          def fix(m):
              v = m.group(3)
              if v.isdigit() and int(v) >= t:
                  return m.group(0)
              return m.group(1) + m.group(2) + str(t)
          for f in files:
              src = open(f, encoding='utf-8').read()
              out = rx.sub(fix, src)
              if out != src:
                  open(f, 'w', encoding='utf-8').write(out)
                  print('minSdk dinaikkan ke', t, 'di', f)
          PY`;

// Auto-tambah "namespace" di build.gradle/.kts untuk base lama yang belum migrasi AGP 7+ (penyebab umum build gagal)
const FIXNS = String.raw`          cat > /tmp/fixns.py <<'PY3'
          import re, glob
          pkg = None
          for mf in glob.glob('android/app/src/main/AndroidManifest.xml'):
              t = open(mf, encoding='utf-8').read()
              m = re.search(r'package="([^"]+)"', t)
              if m:
                  pkg = m.group(1)
                  break
          for f in glob.glob('android/app/build.gradle') + glob.glob('android/app/build.gradle.kts'):
              s = open(f, encoding='utf-8').read()
              if re.search(r'(?m)^\s*namespace\s*[=\s]', s):
                  continue
              m = re.search(r'applicationId\s*[=\s]*"([^"]+)"', s)
              ns = m.group(1) if m else pkg
              if not ns:
                  continue
              m2 = re.search(r'android\s*\{', s)
              if not m2:
                  continue
              i = m2.end()
              line = ('\n    namespace "' + ns + '"\n') if f.endswith('.gradle') else ('\n    namespace = "' + ns + '"\n')
              open(f, 'w', encoding='utf-8').write(s[:i] + line + s[i:])
              print('namespace ditambahkan:', ns, 'di', f)
          PY3`;

// Flutter -> Dart SDK (major*100+minor). Versi yang Dart-nya lebih rendah dari syarat pubspec dilewati (hemat menit)
const DARTOF = {
  '3.0': 217, '3.3': 218, '3.7': 219, '3.10': 300, '3.13': 301, '3.16': 302,
  '3.19': 303, '3.22': 304, '3.24': 305, '3.27': 306, '3.29': 307, '3.32': 308,
  '3.35': 309, '3.38': 310, '3.41': 311, '3.44': 312,
};
const dartOf = (v) => {
  const m = String(v || '').match(/^(\d+\.\d+)/);
  return (m && DARTOF[m[1]]) || null;
};
const dartCond = (v) => {
  const d = dartOf(v);
  return d ? ` && fromJSON(env.DARTMIN || '0') <= ${d}` : '';
};

function attempt(kind, i, v, label, cond = '') {
  cond += dartCond(v);
  const apk = kind === 'apk';
  return `
      - name: Setup Flutter ${label}
        if: env.BUILD_DONE != '1'${cond}
        uses: subosito/flutter-action@v2
        with:
          flutter-version: '${v}'
          channel: stable
          cache: true

      - name: Build dengan Flutter ${label}
        if: env.BUILD_DONE != '1'${cond}
        run: |
          cd "$PROJECT_ROOT"
          set +e
          rm -rf .dart_tool build
          rm -f pubspec.lock
          flutter --version
${apk ? `          if [ ! -d android ]; then
            echo "::notice::Folder android/ tidak ada, dibuat otomatis (flutter create)"
            cp pubspec.yaml /tmp/pubspec.keep; [ -d lib ] && cp -r lib /tmp/lib.keep
            flutter create . --platforms=android --project-name "$(grep -m1 '^name:' pubspec.yaml | awk '{print $2}' | tr -cd 'a-z0-9_')" --org com.base > /tmp/create.log 2>&1 || tail -5 /tmp/create.log
            cp /tmp/pubspec.keep pubspec.yaml; [ -d /tmp/lib.keep ] && { rm -rf lib; cp -r /tmp/lib.keep lib; }
          fi
` : `          if [ ! -d web ]; then
            echo "::notice::Folder web/ tidak ada, dibuat otomatis (flutter create)"
            cp pubspec.yaml /tmp/pubspec.keep; [ -d lib ] && cp -r lib /tmp/lib.keep
            flutter create . --platforms=web --project-name "$(grep -m1 '^name:' pubspec.yaml | awk '{print $2}' | tr -cd 'a-z0-9_')" --org com.base > /tmp/create.log 2>&1 || tail -5 /tmp/create.log
            cp /tmp/pubspec.keep pubspec.yaml; [ -d /tmp/lib.keep ] && { rm -rf lib; cp -r /tmp/lib.keep lib; }
          fi
`}
          LOG=/tmp/build-${i}.log
          NT=0
          SHRINK_OFF='${S.build && S.build.shrink === false ? ' --no-shrink' : ''}'
${apk ? `          if [ "§{{ inputs.build_type }}" = "debug" ]; then
            ARGS="--debug --target-platform android-arm64"
          else
            ARGS="--release --target-platform android-arm64 --split-debug-info=/tmp/dbg§{SHRINK_OFF}"
          fi
` : ''}          for t in 1 2 3; do
            flutter pub get 2>&1 | tee $LOG
            RC=§{PIPESTATUS[0]}
            [ "$RC" -eq 0 ] && break
            grep -Eiq 'version solving|requires|incompatible|resolve' $LOG && ! grep -Eiq 'timed out|connection|socket|HandshakeException|5[0-9][0-9]' $LOG && break
            echo "::warning::pub get gagal, coba lagi ($t/3)"; sleep 4
          done
          if [ "$RC" -eq 0 ]; then
            for n in 1 2 3 4 5; do
              ${apk ? 'flutter build apk --no-pub $ARGS' : 'flutter build web --release --no-pub'} 2>&1 | tee $LOG
              RC=§{PIPESTATUS[0]}
              [ "$RC" -eq 0 ] && break
              if [ "$NT" -lt 2 ] && grep -Eiq 'Could not (resolve|GET|HEAD|download)|Connection (reset|refused)|Read timed out|Connect timed out|Premature end|Received fatal alert|HTTP (5[0-9][0-9])|Unexpected end of stream|Remote host terminated' $LOG; then
                NT=$((NT+1)); echo "::warning::Gangguan jaringan saat build, mengulang ($NT/2)"; sleep 5; continue
              fi
${apk ? `              if ! echo "$ARGS" | grep -q -- '--no-shrink' && echo "$ARGS" | grep -q -- '--release' && grep -Eiq 'R8|minifyReleaseWithR8|Missing classes|proguard|shrinkReleaseRes|missing_rules' $LOG; then
                ARGS="$ARGS --no-shrink"; echo "::notice::Shrink (R8) gagal, mengulang tanpa shrink"; continue
              fi
` : ''}${apk ? `              if ! echo "$ARGS" | grep -q -- '--flavor' && grep -Eiq 'produce an .apk|flavor' $LOG; then
                FL=$(python3 /tmp/flavor.py 2>/dev/null | head -1)
                if [ -n "$FL" ]; then ARGS="$ARGS --flavor $FL"; echo "::notice::Project punya flavor, mengulang dengan --flavor $FL"; continue; fi
              fi
              M=$(grep -o "cannot be smaller than version [0-9]*" $LOG | head -1 | grep -o '[0-9]*$')
              [ -z "$M" ] && break
              echo "::notice::minSdk dinaikkan ke $M lalu build diulang"
              MS=$M python3 /tmp/fixminsdk.py
` : ''}            done
          fi
          if [ "$RC" -eq 0 ]; then
            echo "BUILD_DONE=1" >> "$GITHUB_ENV"
            echo "BUILD_OK=1" >> "$GITHUB_ENV"
            echo "::notice::Build sukses dengan Flutter ${label}"
          elif ! grep -Eiq '${VERSIONISH}' $LOG; then
            echo "BUILD_DONE=1" >> "$GITHUB_ENV"
            echo "Error bukan masalah versi Flutter, tidak mencoba versi lain."
          else
            echo "::warning::Gagal di Flutter ${label}, mencoba versi lain..."
          fi
          exit 0
`;
}

function workflow(kind) {
  const apk = kind === 'apk';
  // Flutter terbaru hanya dicoba PERTAMA kalau project sudah Gradle/AGP 9+ (atau web); selain itu dicoba TERAKHIR
  const chain = CHAIN();
  const latest = chain.find((c) => c.value === '') || { label: 'terbaru', value: '' };
  const rest = chain.filter((c) => c.value !== '');
  const chainTable = rest.map((c) => [c.value, dartOf(c.value)]).filter(([, d]) => d).map(([v, d]) => `${v}|${d}`).join(';');
  const NL = " && env.LEGACY_FLUTTER == ''"; // project Dart lama (<3.0): versi chain modern pasti gagal, dilewati
  const NEARN = " && env.NEAR_VERSION != '' && env.FVM_VERSION == ''" + NL;
  const attempts = (apk ? attempt(kind, 'l', '§{{ env.LEGACY_FLUTTER }}', 'legacy (Dart lama)', " && env.LEGACY_FLUTTER != ''")
      + attempt(kind, 'p', '§{{ env.FVM_VERSION }}', 'versi project', " && env.FVM_VERSION != ''" + NL) : '')
    + attempt(kind, 'n', '§{{ env.NEAR_VERSION }}', 'otomatis (cocok era project)', NEARN)
    + attempt(kind, 'a', latest.value, latest.label + ' (prioritas)', " && env.PREFER_LATEST == '1'" + NL)
    + rest.map((c, i) => attempt(kind, i, c.value, c.label, NL)).join('')
    + attempt(kind, 'z', latest.value, latest.label + ' (terakhir)', " && env.PREFER_LATEST != '1'" + NL);
  return fix(`name: ${apk ? 'Build Flutter' : 'Build Flutter Web'}
run-name: Build §{{ inputs.tag }} (${apk ? '§{{ inputs.build_type }}' : 'web'})

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag yang berisi source ZIP
        required: true
${apk ? `      build_type:
        description: release atau debug
        default: release
` : ''}
permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      CI: 'true'
      FLUTTER_SUPPRESS_ANALYTICS: 'true'
      PUB_ENVIRONMENT: bot_build
    steps:
${apk ? `      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'
` : ''}
      - name: Kunci cache mingguan
        run: echo "WK=$(date +%G-%V)" >> "$GITHUB_ENV"

      - uses: actions/cache@v4
        with:
          path: |
${apk ? `            ~/.gradle/caches
            ~/.gradle/wrapper
            ~/.gradle/native
            ~/.android/build-cache
` : ''}            ~/.pub-cache
          key: ${apk ? 'gradle-pub' : 'pub'}-§{{ runner.os }}-§{{ env.WK }}
          restore-keys: |
            ${apk ? 'gradle-pub' : 'pub'}-§{{ runner.os }}-

      - name: Download & extract source ZIP
        env:
          GH_TOKEN: §{{ secrets.GITHUB_TOKEN }}
        run: |${FIND_ROOT}

      - name: Siapkan project (aset, signing, bersih-bersih)
        run: |
${PREP}

      - name: Deteksi versi Dart minimal project
        run: |
          cd "$PROJECT_ROOT"
          L=$(grep -E '^[[:space:]]+sdk:[[:space:]]*.?[>=^<]' pubspec.yaml | head -1 | grep -oE '[0-9]+[.][0-9]+' | head -1 || true)
          if [ -n "$L" ]; then
            echo "DARTMIN=$(( §{L%%.*} * 100 + §{L##*.} ))" >> "$GITHUB_ENV"
            echo "Dart minimal project: $L (versi Flutter yang terlalu lama dilewati)"
          fi
          # versi Flutter yang dikunci project (FVM / pubspec environment)
          FV=""
          [ -f .fvmrc ] && FV=$(grep -oE '"flutter"[[:space:]]*:[[:space:]]*"[0-9]+[.][0-9]+[.][0-9]+"' .fvmrc | grep -oE '[0-9]+[.][0-9]+[.][0-9]+' | head -1 || true)
          if [ -z "$FV" ] && [ -f .fvm/fvm_config.json ]; then FV=$(grep -oE '"flutterSdkVersion"[[:space:]]*:[[:space:]]*"[0-9]+[.][0-9]+[.][0-9]+"' .fvm/fvm_config.json | grep -oE '[0-9]+[.][0-9]+[.][0-9]+' | head -1 || true); fi
          if [ -z "$FV" ]; then FV=$(awk '/^environment:/{e=1;next} e&&/^[^ #]/{e=0} e' pubspec.yaml | grep -E '^[[:space:]]+flutter:[[:space:]]*.?[0-9]+[.][0-9]+[.][0-9]+.?[[:space:]]*$' | grep -oE '[0-9]+[.][0-9]+[.][0-9]+' | head -1 || true); fi
          if [ -n "$FV" ]; then echo "FVM_VERSION=$FV" >> "$GITHUB_ENV"; echo "Project mengunci Flutter $FV (dicoba pertama)"; fi
          # Dart lama (batas atas < 3.0): hanya Flutter lama yang bisa
          UB=$(awk '/^environment:/{e=1;next} e&&/^[^ #]/{e=0} e' pubspec.yaml | grep -E '^[[:space:]]+sdk:' | head -1 | grep -oE '<[[:space:]]*[0-9]+[.][0-9]+' | grep -oE '[0-9]+[.][0-9]+' | head -1 || true)
          if [ -n "$UB" ] && [ "$(( §{UB%%.*} * 100 + §{UB##*.} ))" -le 300 ]; then
            LMJ=§{L%%.*}; LMN=§{L##*.}
            [ -z "$L" ] && { LMJ=2; LMN=19; }
            LM=$(( LMJ * 100 + LMN ))
            if [ "$LM" -ge 219 ]; then LF=3.7.12; elif [ "$LM" -eq 218 ]; then LF=3.3.10; elif [ "$LM" -eq 217 ]; then LF=3.0.5; else LF=2.10.5; fi
            echo "LEGACY_FLUTTER=$LF" >> "$GITHUB_ENV"
            echo "::notice::Project memakai Dart lama (sdk < $UB): memakai Flutter $LF"
          fi
          # pilih versi Flutter paling dekat (tertua yang Dart-nya masih cukup) -> base lama lgsg kena sekali coba, gak perlu turun satu-satu dari yang paling baru
          if [ -n "$DARTMIN" ] && [ -z "$LEGACY_FLUTTER" ] && [ -z "$FV" ]; then
            BEST=""; BESTD=999999
            IFS=';' read -ra __PAIRS <<< "${chainTable}"
            for P in "§{__PAIRS[@]}"; do
              CV="§{P%%|*}"; CD="§{P##*|}"
              if [ "$CD" -ge "$DARTMIN" ] && [ "$CD" -lt "$BESTD" ]; then BEST="$CV"; BESTD="$CD"; fi
            done
            if [ -n "$BEST" ]; then
              echo "NEAR_VERSION=$BEST" >> "$GITHUB_ENV"
              echo "::notice::Dicoba duluan Flutter $BEST (paling cocok requirement Dart project, hemat waktu build)"
            fi
          fi
${apk ? `
      - name: Auto-fix minSdk (minimal 24)
        run: |
          cd "$PROJECT_ROOT"
${FIXMS}
          cat > /tmp/flavor.py <<'PY2'
          import re, glob
          for f in glob.glob('android/app/build.gradle') + glob.glob('android/app/build.gradle.kts'):
              t = open(f, encoding='utf-8').read()
              i = t.find('productFlavors')
              if i < 0:
                  continue
              m = re.search(r'(?:create|register)[(][ ]*"([A-Za-z0-9_]+)"[ ]*[)]|^[ ]*([A-Za-z0-9_]+)[ ]*[{]', t[t.find('{', i) + 1:], re.M)
              if m:
                  print(m.group(1) or m.group(2))
                  break
          PY2
          MS=24 python3 /tmp/fixminsdk.py
${FIXNS}
          python3 /tmp/fixns.py
` : ''}
${apk ? `
      - name: Deteksi Gradle/AGP project
        run: |
          cd "$PROJECT_ROOT"
          GV=$(grep -o 'gradle-[0-9]*' android/gradle/wrapper/gradle-wrapper.properties 2>/dev/null | head -1 | grep -o '[0-9]*$' || true)
          AV=$(cat android/settings.gradle android/settings.gradle.kts android/build.gradle android/build.gradle.kts 2>/dev/null | grep -oE 'com[.]android[.](application|tools[.]build:gradle)[^0-9]{0,40}[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)
          echo "Gradle major: §{GV:-?}, AGP major: §{AV:-?}"
          GVF=$(grep -oE 'gradle-[0-9]+[.][0-9]+' android/gradle/wrapper/gradle-wrapper.properties 2>/dev/null | head -1 | sed 's/gradle-//' || true)
          if [ -n "$GVF" ]; then
            GJ=17
            if [ "§{GVF%%.*}" -lt 5 ]; then GJ=8; elif [ "§{GVF%%.*}" -lt 7 ] || { [ "§{GVF%%.*}" -eq 7 ] && [ "§{GVF##*.}" -lt 3 ]; }; then GJ=11; fi
            if [ "$GJ" != "17" ]; then
              JH=$(printenv "JAVA_HOME_§{GJ}_X64" || true)
              if [ -n "$JH" ]; then
                echo "JAVA_HOME=$JH" >> "$GITHUB_ENV"; echo "$JH/bin" >> "$GITHUB_PATH"
                echo "::notice::Gradle $GVF butuh Java $GJ, dipakai"
              fi
            fi
          fi
          if [ "§{GV:-0}" -ge 9 ] || [ "§{AV:-0}" -ge 9 ]; then
            echo "PREFER_LATEST=1" >> "$GITHUB_ENV"
            echo "::notice::Project Gradle/AGP 9+, mulai dari Flutter terbaru"
          fi
` : `
      - name: Prioritas Flutter terbaru (web)
        run: echo "PREFER_LATEST=1" >> "$GITHUB_ENV"
`}
${apk ? `
      - name: Bersihkan opsi Gradle usang (dihapus di AGP baru)
        run: |
          cd "$PROJECT_ROOT"
          for f in android/gradle.properties; do
            [ -f "$f" ] || continue
            sed -i -E '/^[[:space:]]*android[.](enableDexingArtifactTransform([.]desugaring)?|enableD8([.]desugaring)?|enableR8|useDeprecatedNdk|enableUnitTestBinaryResources|enableBuildCache|enableAapt2|enableSeparateAnnotationProcessing)[[:space:]]*=/d' "$f"
            echo "gradle.properties dibersihkan dari opsi usang"
          done
` : ''}
${apk ? `      - name: Optimasi Gradle
        run: |
          AV=$(df --output=avail -BG / | tail -1 | tr -dc 0-9)
          if [ "§{AV:-99}" -lt 8 ]; then sudo rm -rf /usr/share/dotnet /opt/ghc /usr/local/share/boost; fi
          mkdir -p ~/.gradle
          {
            echo 'org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g'
            echo 'org.gradle.parallel=true'
            echo 'org.gradle.caching=true'
            echo 'org.gradle.configureondemand=true'
            echo 'org.gradle.vfs.watch=false'
            echo 'kotlin.compiler.execution.strategy=in-process'
            echo 'kotlin.incremental=true'
            echo 'android.enableJetifier=false'
          } >> ~/.gradle/gradle.properties
          # lewati lintVital (lambat, tidak berpengaruh ke APK)
          mkdir -p ~/.gradle/init.d
          echo 'allprojects { tasks.configureEach { t -> if (t.name.startsWith("lintVital") || t.name.startsWith("lintAnalyze") || t.name.startsWith("lintReport")) { t.enabled = false } } }' > ~/.gradle/init.d/skiplint.gradle
` : ''}
${attempts}
      - name: Cek hasil build
        if: env.BUILD_OK != '1'
        run: |
          echo "::error::Build gagal. Versi Flutter yang dicoba: ${[...CHAIN().filter((c) => c.value !== ''), CHAIN().find((c) => c.value === '') || { label: 'terbaru' }].map((c) => c.label).join(', ')}"
          for f in /tmp/build-*.log; do
            echo "=== $f ==="
            grep -iE 'error|failed|went wrong|minimum|cannot be smaller' "$f" | tail -30 || true
          done
          exit 1

      - uses: actions/upload-artifact@v4
        with:
          name: ${apk ? 'app-§{{ inputs.build_type }}' : 'web-build'}
          path: §{{ env.PROJECT_ROOT }}/${apk ? 'build/app/outputs/flutter-apk/*.apk' : 'build/web'}
          if-no-files-found: error
          retention-days: 1
          compression-level: 0
`);
}

const FLUTTER = workflow('apk');
const ANDROID_PREP = String.raw`          cd "$ANDROID_ROOT"
          rm -rf build .gradle app/build 2>/dev/null || true
          echo "sdk.dir=$ANDROID_HOME" > local.properties
          # buang opsi Gradle usang yang membuat AGP baru error
          if [ -f gradle.properties ]; then
            sed -i -E '/^[[:space:]]*android[.](enableDexingArtifactTransform([.]desugaring)?|enableD8([.]desugaring)?|enableR8|useDeprecatedNdk|enableUnitTestBinaryResources|enableBuildCache|enableAapt2|enableSeparateAnnotationProcessing)[[:space:]]*=/d' gradle.properties
          fi
          # gradle wrapper hilang -> buat
          if [ ! -f gradlew ]; then
            echo "::notice::gradlew tidak ada, dibuat otomatis"
            gradle wrapper --gradle-version 8.10.2 || true
          fi
          chmod +x gradlew 2>/dev/null || true
          # pilih Java sesuai versi Gradle project
          GV=$(grep -h distributionUrl gradle/wrapper/gradle-wrapper.properties 2>/dev/null | grep -oE 'gradle-[0-9]+[.][0-9]+' | head -1 | sed 's/gradle-//' || true)
          GMAJ=$(echo "$GV" | cut -d. -f1); GMIN=$(echo "$GV" | cut -d. -f2)
          JV=17
          if [ -n "$GMAJ" ]; then
            if [ "$GMAJ" -lt 5 ]; then JV=8
            elif [ "$GMAJ" -eq 6 ] || { [ "$GMAJ" -eq 5 ] && true; } || { [ "$GMAJ" -eq 7 ] && [ "$GMIN" -lt 3 ]; }; then JV=11
            fi
          fi
          JH=$(printenv "JAVA_HOME_§{JV}_X64" || true)
          [ -z "$JH" ] && JH=$(printenv JAVA_HOME_17_X64 || true)
          echo "Gradle: §{GV:-?} -> Java $JV ($JH)"
          if [ -n "$JH" ]; then
            echo "JAVA_HOME=$JH" >> "$GITHUB_ENV"
            echo "$JH/bin" >> "$GITHUB_PATH"
          fi
          # pasang platform SDK yang dibutuhkan project (jika belum ada)
          yes | sdkmanager --licenses > /dev/null 2>&1 || true
          for N in $(grep -rhoE 'compileSdk(Version)?[ =(]+[0-9]+' --include=build.gradle --include=build.gradle.kts . 2>/dev/null | grep -oE '[0-9]+$' | sort -un); do
            if [ ! -d "$ANDROID_HOME/platforms/android-$N" ]; then
              echo "Memasang platforms;android-$N"
              sudo -E "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platforms;android-$N" > /dev/null 2>&1 || sdkmanager "platforms;android-$N" > /dev/null 2>&1 || true
            fi
          done
          # lewati lintVital (lambat)
          mkdir -p ~/.gradle/init.d
          echo 'allprojects { tasks.configureEach { t -> if (t.name.startsWith("lintVital") || t.name.startsWith("lintAnalyze") || t.name.startsWith("lintReport")) { t.enabled = false } } }' > ~/.gradle/init.d/skiplint.gradle
          {
            echo 'org.gradle.parallel=true'
            echo 'org.gradle.caching=true'
            echo 'org.gradle.vfs.watch=false'
            echo 'kotlin.compiler.execution.strategy=in-process'
          } >> ~/.gradle/gradle.properties`;

const HTML = htmlWorkflow();
const ANDROID = androidWorkflow();


// ZIP project Android native (Gradle: Java/Kotlin) -> APK. Memilih Java sesuai versi Gradle project.

function androidWorkflow() {
  return fix(`name: Build Android APK
run-name: Build §{{ inputs.tag }} (android §{{ inputs.build_type }})

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag yang berisi source ZIP
        required: true
      build_type:
        description: release atau debug
        required: false
        default: release

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    env:
      CI: 'true'
    steps:
      - uses: gradle/actions/setup-gradle@v4

      - name: Download & extract source ZIP
        env:
          GH_TOKEN: §{{ secrets.GITHUB_TOKEN }}
        run: |${EXTRACT}
          ALL=$(find . -maxdepth 7 \\( -name settings.gradle -o -name settings.gradle.kts \\) -not -path '*/node_modules/*' -not -path '*/__MACOSX/*' -not -path '*/.gradle/*' | awk '{print length, $0}' | sort -n | cut -d' ' -f2- || true)
          S=$(echo "$ALL" | head -1)
          if [ -z "$S" ]; then
            S=$(grep -rlE 'com[.]android[.]application|android-application' --include=build.gradle --include=build.gradle.kts . 2>/dev/null | awk '{print length, $0}' | sort -n | head -1 | cut -d' ' -f2- || true)
          fi
          if [ -z "$S" ]; then
            echo "Isi ZIP (3 level teratas):"
            find . -maxdepth 3 | head -60 || true
            if find . -maxdepth 4 -name pubspec.yaml | grep -q .; then echo "::error::Ini project Flutter. Pakai menu Build Flutter."; else echo "::error::Project Android (Gradle) tidak ditemukan: tidak ada settings.gradle. Zip folder project Android Studio (Java/Kotlin)."; fi
            exit 1
          fi
          ROOT=$(cd "$(dirname "$S")" && pwd)
          echo "ANDROID_ROOT=$ROOT" >> "$GITHUB_ENV"
          echo "Android root: $ROOT"

      - name: Siapkan project (Java, SDK, wrapper)
        run: |
${ANDROID_PREP}

      - name: Build APK
        run: |
          yes | sdkmanager --licenses > /dev/null 2>&1 || true
          set -o pipefail
          cd "$ANDROID_ROOT"
          TYPE="§{{ inputs.build_type }}"
          if [ "$TYPE" = "debug" ]; then TASK=assembleDebug; else TASK=assembleRelease; fi
          for t in 1 2 3; do
            ./gradlew $TASK --no-daemon --parallel --build-cache --console=plain --stacktrace 2>&1 | tee /tmp/build-android.log && break
            if [ "$t" -lt 3 ] && grep -Eiq 'Could not (resolve|GET|HEAD|download)|Connection (reset|refused)|Read timed out|Connect timed out|Premature end|Received fatal alert|HTTP 5[0-9][0-9]|Remote host terminated' /tmp/build-android.log; then
              echo "::warning::Gangguan jaringan, mengulang ($t/3)"; sleep 6
            else
              exit 1
            fi
          done

      - name: Kumpulkan & tanda tangani APK
        run: |
          set -e
          cd "$ANDROID_ROOT"
          mkdir -p /tmp/out /tmp/work
          BT=$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)
          keytool -genkeypair -keystore /tmp/k.jks -storepass android -keypass android -alias key -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Build" > /dev/null 2>&1
          find . -path '*/build/outputs/apk/*' -name '*.apk' -not -name '*androidTest*' -not -path '*/androidTest/*' | head -8 > /tmp/apks.txt
          if [ ! -s /tmp/apks.txt ]; then
            echo "::error::Build selesai tapi tidak ada file .apk (project mungkin library/AAB saja). Pastikan ada module com.android.application."
            find . -path '*/build/outputs/*' | head -30 || true
            exit 1
          fi
          while read -r f; do
            N=$(basename "$f")
            case "$N" in
              *unsigned*)
                OUTN="§{N/-unsigned/}"
                "$ANDROID_HOME/build-tools/$BT/zipalign" -f -p 4 "$f" /tmp/work/aligned.apk
                "$ANDROID_HOME/build-tools/$BT/apksigner" sign --ks /tmp/k.jks --ks-pass pass:android --key-pass pass:android --ks-key-alias key --out "/tmp/out/§{OUTN}" /tmp/work/aligned.apk
                echo "Ditandatangani: $OUTN"
                ;;
              *) cp "$f" "/tmp/out/$N" ;;
            esac
          done < /tmp/apks.txt
          ls -la /tmp/out

      - uses: actions/upload-artifact@v4
        with:
          name: android-apk
          path: /tmp/out/*.apk
          if-no-files-found: error
          retention-days: 1
          compression-level: 0
`);
}

// HTML -> APK: bungkus folder web (index.html) ke WebView Android. Tanpa Flutter/npm, jadi cepat.
function htmlWorkflow() {
  return fix(`name: Build HTML to APK
run-name: Build §{{ inputs.tag }} (html)

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag yang berisi source ZIP
        required: true

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: '8.10.2'

      - name: Download & extract source ZIP
        env:
          GH_TOKEN: §{{ secrets.GITHUB_TOKEN }}
        run: |
          mkdir -p meta
          gh release download "§{{ inputs.tag }}" --repo §{{ github.repository }} --pattern "icon.png" --pattern "meta.txt" --dir meta || true${EXTRACT}
          IDX=$(find . -iname index.html -not -path '*/__MACOSX/*' -not -path '*/node_modules/*' | awk '{print length, $0}' | sort -n | sed -n '1p' | cut -d' ' -f2- || true)
          if [ -z "$IDX" ]; then
            echo "Isi ZIP (3 level teratas):"
            find . -maxdepth 3 | head -60 || true
            echo "::error::index.html tidak ditemukan di dalam ZIP. Zip folder web yang berisi index.html."
            exit 1
          fi
          ROOT=$(cd "$(dirname "$IDX")" && pwd)
          echo "WEB_ROOT=$ROOT" >> "$GITHUB_ENV"
          echo "Web root: $ROOT"

      - name: Buat project Android (WebView)
        run: |
          set -e
          H=$(echo "§{{ inputs.tag }}" | md5sum | cut -c1-8)
          META="$GITHUB_WORKSPACE/meta"
          TITLE=""
          [ -f "$META/meta.txt" ] && TITLE=$(head -1 "$META/meta.txt" | tr -cd '[:alnum:] _.-' | cut -c1-30 || true)
          [ -z "$TITLE" ] && TITLE=$(grep -io '<title>[^<]*' "$WEB_ROOT/index.html" | head -1 | sed 's/<[tT][iI][tT][lL][eE]>//' | tr -cd '[:alnum:] _.-' | cut -c1-40 || true)
          [ -z "$TITLE" ] && TITLE="Web App"
          PLAT=$(ls "$ANDROID_HOME/platforms" | sed 's/android-//' | grep -E '^[0-9]+$' | sort -n | tail -1)
          BT=$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)
          echo "Android platform $PLAT, build-tools $BT, title: $TITLE"
          echo "APP_ID=com.htmlapk.a$H" >> "$GITHUB_ENV"
          echo "APP_TITLE=$TITLE" >> "$GITHUB_ENV"
          echo "COMPILE_SDK=$PLAT" >> "$GITHUB_ENV"
          echo "BUILD_TOOLS=$BT" >> "$GITHUB_ENV"
          A=/tmp/app
          mkdir -p $A/app/src/main/java/com/htmlapk/web $A/app/src/main/assets/www $A/app/src/main/res/values
          cp -r "$WEB_ROOT"/. $A/app/src/main/assets/www/
          rm -rf $A/app/src/main/assets/www/__MACOSX
          ICON_RES=@android:drawable/sym_def_app_icon
          if [ -f "$META/icon.png" ]; then
            for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
              mkdir -p $A/app/src/main/res/mipmap-§{d%%:*}
              SZ=§{d##*:}
              OUT=$A/app/src/main/res/mipmap-§{d%%:*}/ic_launcher.png
              convert "$META/icon.png[0]" -background none -resize §{SZ}x§{SZ}^ -gravity center -extent §{SZ}x§{SZ} "PNG32:$OUT" 2>/dev/null \
                || magick "$META/icon.png[0]" -background none -resize §{SZ}x§{SZ}^ -gravity center -extent §{SZ}x§{SZ} "PNG32:$OUT" 2>/dev/null \
                || cp "$META/icon.png" "$OUT"
            done
            ICON_RES=@mipmap/ic_launcher
          else
            ICON_RES=@android:drawable/sym_def_app_icon
          fi
          echo "<resources><string name=\\"app_name\\">$TITLE</string></resources>" > $A/app/src/main/res/values/strings.xml
          {
            echo "android.suppressUnsupportedCompileSdk=$PLAT"
            echo "org.gradle.jvmargs=-Xmx3g"
            echo "org.gradle.parallel=true"
            echo "org.gradle.caching=true"
          } > $A/gradle.properties
          cat > $A/settings.gradle <<'EOF'
          pluginManagement {
            repositories { google(); mavenCentral(); gradlePluginPortal() }
          }
          dependencyResolutionManagement {
            repositories { google(); mavenCentral() }
          }
          rootProject.name = 'htmlapk'
          include ':app'
          EOF
          cat > $A/build.gradle <<'EOF'
          plugins { id 'com.android.application' version '8.7.3' apply false }
          EOF
          cat > $A/app/build.gradle <<'EOF'
          plugins { id 'com.android.application' }
          android {
            namespace 'com.htmlapk.web'
            compileSdk System.getenv('COMPILE_SDK').toInteger()
            buildToolsVersion System.getenv('BUILD_TOOLS')
            defaultConfig {
              applicationId System.getenv('APP_ID')
              minSdk 21
              targetSdk 34
              versionCode 1
              versionName '1.0'
            }
            signingConfigs {
              release {
                storeFile file(System.getenv('KS_FILE'))
                storePassword 'android'
                keyAlias 'key'
                keyPassword 'android'
              }
            }
            buildTypes {
              release {
                signingConfig signingConfigs.release
                minifyEnabled false
                shrinkResources false
              }
            }
            lint { abortOnError false; checkReleaseBuilds false }
          }
          EOF
          cat > $A/app/src/main/AndroidManifest.xml <<'EOF'
          <?xml version="1.0" encoding="utf-8"?>
          <manifest xmlns:android="http://schemas.android.com/apk/res/android">
            <uses-permission android:name="android.permission.INTERNET"/>
            <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
            <application
              android:label="@string/app_name"
              android:icon="@android:drawable/sym_def_app_icon"
              android:usesCleartextTraffic="true"
              android:allowBackup="true"
              android:theme="@android:style/Theme.DeviceDefault.NoActionBar">
              <activity
                android:name=".MainActivity"
                android:exported="true"
                android:configChanges="orientation|screenSize|keyboardHidden|smallestScreenSize|screenLayout"
                android:windowSoftInputMode="adjustResize">
                <intent-filter>
                  <action android:name="android.intent.action.MAIN"/>
                  <category android:name="android.intent.category.LAUNCHER"/>
                </intent-filter>
              </activity>
            </application>
          </manifest>
          EOF
          sed -i "s#@android:drawable/sym_def_app_icon#$ICON_RES#" $A/app/src/main/AndroidManifest.xml
          cat > $A/app/src/main/java/com/htmlapk/web/MainActivity.java <<'EOF'
          package com.htmlapk.web;

          import android.app.Activity;
          import android.content.Intent;
          import android.net.Uri;
          import android.os.Bundle;
          import android.webkit.WebChromeClient;
          import android.webkit.WebResourceRequest;
          import android.webkit.WebSettings;
          import android.webkit.WebView;
          import android.webkit.WebViewClient;

          public class MainActivity extends Activity {
            private WebView web;

            @Override
            protected void onCreate(Bundle b) {
              super.onCreate(b);
              web = new WebView(this);
              setContentView(web);
              WebSettings s = web.getSettings();
              s.setJavaScriptEnabled(true);
              s.setDomStorageEnabled(true);
              s.setDatabaseEnabled(true);
              s.setAllowFileAccess(true);
              s.setAllowFileAccessFromFileURLs(true);
              s.setAllowUniversalAccessFromFileURLs(true);
              s.setMediaPlaybackRequiresUserGesture(false);
              s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
              web.setWebChromeClient(new WebChromeClient());
              web.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                  String u = r.getUrl().toString();
                  if (u.startsWith("file:") || u.startsWith("http:") || u.startsWith("https:")
                      || u.startsWith("about:") || u.startsWith("data:") || u.startsWith("blob:")
                      || u.startsWith("javascript:")) return false;
                  try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); } catch (Exception e) { }
                  return true;
                }
              });
              if (b != null) web.restoreState(b);
              else web.loadUrl("file:///android_asset/www/index.html");
            }

            @Override
            protected void onSaveInstanceState(Bundle o) {
              super.onSaveInstanceState(o);
              web.saveState(o);
            }

            @Override
            public void onBackPressed() {
              if (web.canGoBack()) web.goBack(); else super.onBackPressed();
            }
          }
          EOF

      - name: Buat keystore
        run: |
          keytool -genkeypair -keystore /tmp/app.jks -storepass android -keypass android -alias key -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=HTML APK" > /dev/null 2>&1
          echo "KS_FILE=/tmp/app.jks" >> "$GITHUB_ENV"

      - name: Build APK
        run: |
          yes | sdkmanager --licenses > /dev/null 2>&1 || true
          set -o pipefail
          cd /tmp/app
          for t in 1 2 3; do
            gradle assembleRelease --no-daemon --parallel --build-cache --console=plain 2>&1 | tee /tmp/build-html.log && break
            if [ "$t" -lt 3 ] && grep -Eiq 'Could not (resolve|GET|HEAD|download)|Connection (reset|refused)|timed out|Premature end|Received fatal alert|HTTP 5[0-9][0-9]' /tmp/build-html.log; then
              echo "::warning::Gangguan jaringan, mengulang ($t/3)"; sleep 6
            else
              exit 1
            fi
          done
          mkdir -p /tmp/out
          N=§{APP_TITLE// /_}
          cp app/build/outputs/apk/release/app-release.apk "/tmp/out/§{N}.apk"

      - uses: actions/upload-artifact@v4
        with:
          name: html-apk
          path: /tmp/out/*.apk
          if-no-files-found: error
          retention-days: 1
          compression-level: 0
`);
}

async function put(server, file, content, branch) {
  const p = `/repos/${server.repo}/contents/.github/workflows/${file}`;
  let sha;
  try {
    const cur = await gh.api('GET', `${p}?ref=${encodeURIComponent(branch)}`);
    if (Buffer.from(cur.content, 'base64').toString('utf8') === content) return 'sudah terbaru';
    sha = cur.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const body = { message: `bot: ${sha ? 'update' : 'tambah'} ${file}`, content: Buffer.from(content).toString('base64'), branch };
  if (sha) body.sha = sha;
  try {
    await gh.api('PUT', p, { body });
  } catch (e) {
    if (e.status === 404 || e.status === 409 || e.status === 422) { // repo kosong / branch belum ada
      delete body.branch;
      await gh.api('PUT', p, { body });
    } else throw e;
  }
  return sha ? 'diperbarui' : 'dibuat';
}

// Mengembalikan teks laporan; throw kalau token/repo salah
async function ensure(server) {
  const repo = await gh.api('GET', `/repos/${server.repo}`);
  if (!repo.permissions?.push) throw new Error('Token tidak punya akses push ke repo ini (butuh scope repo + workflow).');
  try {
    await gh.api('GET', `/repos/${server.repo}/branches/${encodeURIComponent(server.branch)}`);
  } catch (e) {
    if (e.status === 404 && repo.default_branch) { server.branch = repo.default_branch; require('./db').save(); }
  }
  const b = server.branch;
  const r1 = await put(server, S.github.flutterWorkflow, FLUTTER, b);
  const aw = S.github.androidWorkflow || 'build-android.yml';
  const r2 = await put(server, aw, ANDROID, b);
  const hw = S.github.htmlWorkflow || 'build-html.yml';
  const r3 = await put(server, hw, HTML, b);
  return `📱 ${S.github.flutterWorkflow}: ${r1}\n📦 ${aw}: ${r2}\n🧱 ${hw}: ${r3}\n🌿 Branch: ${server.branch}`;
}

const files = () => ({ [S.github.flutterWorkflow]: FLUTTER, [S.github.androidWorkflow || 'build-android.yml']: ANDROID, [S.github.htmlWorkflow || 'build-html.yml']: HTML });

// cek cepat sebelum dipasang: harus ada trigger, run-name, dan tidak ada sisa placeholder
function selfCheck() {
  const bad = [];
  for (const [name, y] of Object.entries(files())) {
    if (!/workflow_dispatch/.test(y)) bad.push(`${name}: tanpa workflow_dispatch`);
    if (!/run-name:/.test(y)) bad.push(`${name}: tanpa run-name`);
    if (/§|\$\{\{\s*\}\}/.test(y)) bad.push(`${name}: sisa placeholder`);
    if (/\t/.test(y)) bad.push(`${name}: ada karakter TAB`);
  }
  return bad;
}


// ---- Anti-Gagal ----
// preflight: sebelum build, pastikan workflow di repo = versi terbaru (di-cache 10 menit per repo, murah: 1-3 request)
const okCache = new Map();
const keyOf = (server) => `${server.repo}@${server.branch}`;
const invalidate = (server) => okCache.delete(keyOf(server));
async function preflight(server) {
  const k = keyOf(server);
  const hit = okCache.get(k);
  if (hit && Date.now() - hit < 10 * 60e3) return;
  if (selfCheck().length) return; // template bermasalah: jangan timpa workflow yang masih jalan
  await ensure(server);
  okCache.set(k, Date.now());
}

// heal: pulihkan workflow yang tidak terbaca/nonaktif: aktifkan Actions, pasang ulang, aktifkan workflow
async function heal(server) {
  const bad = selfCheck();
  if (bad.length) throw new Error(`Template bermasalah: ${bad.join('; ')}`);
  const repo = await gh.api('GET', `/repos/${server.repo}`);
  if (!repo.permissions?.push) throw new Error('Token tidak punya akses push (butuh scope repo + workflow).');
  if (repo.archived) throw new Error('Repo diarsipkan (read-only).');
  try {
    const perm = await gh.api('GET', `/repos/${server.repo}/actions/permissions`);
    if (perm.enabled === false) await gh.api('PUT', `/repos/${server.repo}/actions/permissions`, { body: { enabled: true, allowed_actions: 'all' } });
  } catch { /* butuh admin: abaikan */ }
  await ensure(server);
  await new Promise((r) => setTimeout(r, 3000));
  for (const file of Object.keys(files())) {
    try {
      const wf = await gh.api('GET', `/repos/${server.repo}/actions/workflows/${encodeURIComponent(file)}`);
      if (wf.state && wf.state !== 'active') await gh.api('PUT', `/repos/${server.repo}/actions/workflows/${wf.id}/enable`).catch(() => {});
    } catch { /* belum terindeks, abaikan */ }
  }
  okCache.set(keyOf(server), Date.now());
}

module.exports = { ensure, files, selfCheck, preflight, heal, invalidate };
