# 分类账 CatLedger — APK 构建脚本（不依赖 Gradle / Android Studio）
# 流程: aapt2 compile+link → javac → d8 → 塞 dex → zipalign → apksigner
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File build-apk.ps1
#
# 注意：本机沙箱环境里 aapt2 只能用相对路径访问目录，因此构建全过程
# 都在 build\ 目录下以相对路径执行，最后再把 APK 拷到 apk\。
#
# 版本号唯一来源是 android\AndroidManifest.xml 里的 versionCode / versionName，
# 改版本只改那一处（aapt2 的 --version-* 参数不会覆盖清单里的值）。

param(
    [string]$KsPass = "catledger"
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Work = Join-Path $Root 'build'
$Pkg = 'com\catledger\app'

function Step($msg) { Write-Host ("`n==> " + $msg) -ForegroundColor Cyan }
function Fail($msg) { Write-Host ("[失败] " + $msg) -ForegroundColor Red; exit 1 }

# ---------- 0. 找工具 ----------
Step "定位 Android 构建工具"
$sdkDir = Join-Path $Root '.sdk'
if (-not (Test-Path $sdkDir)) { Fail "缺少 .sdk 目录（node scripts/fetch-chunks.mjs + 解压）" }

$aapt2 = Get-ChildItem $sdkDir -Recurse -Filter aapt2.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $aapt2) { Fail "找不到 aapt2.exe" }
$btDir = $aapt2.DirectoryName
$d8 = Join-Path $btDir 'd8.bat'
$zipalign = Join-Path $btDir 'zipalign.exe'
$apksigner = Join-Path $btDir 'apksigner.bat'
foreach ($t in @($d8, $zipalign, $apksigner)) { if (-not (Test-Path $t)) { Fail "缺少工具 $t" } }

$androidJar = (Get-ChildItem $sdkDir -Recurse -Filter android.jar -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $androidJar) { Fail "找不到 android.jar" }
$androidJar = $androidJar.FullName

$javaHome = $env:JAVA_HOME
if (-not $javaHome -or -not (Test-Path (Join-Path $javaHome 'bin\javac.exe'))) {
    $j = Get-Command java -ErrorAction SilentlyContinue
    if (-not $j) { Fail "找不到 JDK" }
    $javaHome = Split-Path -Parent (Split-Path -Parent $j.Source)
}
$javac = Join-Path $javaHome 'bin\javac.exe'
$keytool = Join-Path $javaHome 'bin\keytool.exe'

Write-Host "  aapt2      : $($aapt2.FullName)"
Write-Host "  android.jar: $androidJar"

# ---------- 1. 准备构建目录 ----------
Step "准备构建目录 build\"
if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
foreach ($d in @('', 'gen', 'classes', 'dex', 'flat', 'assets', 'assets\www')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Work $d) | Out-Null
}
Copy-Item (Join-Path $Root 'android\AndroidManifest.xml') $Work -Force
Copy-Item (Join-Path $Root 'android\res') $Work -Recurse -Force
Copy-Item (Join-Path $Root 'android\src') $Work -Recurse -Force
Copy-Item (Join-Path $Root 'www\*') (Join-Path $Work 'assets') -Recurse -Force
Copy-Item $androidJar (Join-Path $Work 'android.jar') -Force

$wwwSize = (Get-ChildItem (Join-Path $Work 'assets') -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("  前端资源 {0:N1} KB" -f ($wwwSize / 1KB))

# 从清单里读版本号（唯一来源），用于产物命名
$mfText = [System.IO.File]::ReadAllText((Join-Path $Work 'AndroidManifest.xml'), [System.Text.Encoding]::UTF8)
$VersionCode = [int]([regex]::Match($mfText, 'android:versionCode="(\d+)"').Groups[1].Value)
$VersionName = [regex]::Match($mfText, 'android:versionName="([^"]+)"').Groups[1].Value
if (-not $VersionName) { Fail "清单里没有 android:versionName" }
Write-Host ("  版本 {0} (versionCode {1})" -f $VersionName, $VersionCode)

Push-Location $Work
try {
    # ---------- 2. 资源 ----------
    Step "aapt2 compile"
    & $aapt2.FullName compile --dir res -o flat
    if ($LASTEXITCODE -ne 0) { Fail "aapt2 compile 失败" }

    Step "aapt2 link"
    $flatFiles = Get-ChildItem 'flat' -Recurse -Filter *.flat | ForEach-Object {
        $_.FullName.Substring((Get-Location).Path.Length + 1)
    }
    Write-Host ("  资源条目 {0} 个" -f $flatFiles.Count)
    & $aapt2.FullName link `
        -o base.apk `
        -I android.jar `
        --manifest AndroidManifest.xml `
        --java gen `
        -A assets `
        --min-sdk-version 24 `
        --target-sdk-version 34 `
        --auto-add-overlay `
        $flatFiles
    if ($LASTEXITCODE -ne 0) { Fail "aapt2 link 失败" }
    Write-Host ("  base.apk {0:N1} KB" -f ((Get-Item 'base.apk').Length / 1KB))

    # ---------- 3. Java ----------
    Step "javac"
    if (-not (Test-Path "gen\$Pkg\R.java")) { Fail "没有生成 R.java" }
    & $javac --release 8 -encoding UTF-8 -nowarn -classpath android.jar -d classes `
        "src\$Pkg\MainActivity.java" "gen\$Pkg\R.java"
    if ($LASTEXITCODE -ne 0) { Fail "javac 失败" }

    # ---------- 4. dex ----------
    Step "d8 转 dex"
    $classes = Get-ChildItem 'classes' -Recurse -Filter *.class | ForEach-Object {
        $_.FullName.Substring((Get-Location).Path.Length + 1)
    }
    & $d8 --release --min-api 24 --lib android.jar --output dex $classes
    if ($LASTEXITCODE -ne 0) { Fail "d8 失败" }
    if (-not (Test-Path 'dex\classes.dex')) { Fail "没有生成 classes.dex" }
    Write-Host ("  classes.dex {0:N1} KB" -f ((Get-Item 'dex\classes.dex').Length / 1KB))

    # ---------- 5. 塞 dex ----------
    Step "打包 classes.dex 进 APK"
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open((Join-Path (Get-Location) 'base.apk'), [System.IO.Compression.ZipArchiveMode]::Update)
    try {
        $old = $zip.GetEntry('classes.dex')
        if ($old) { $old.Delete() }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, (Join-Path (Get-Location) 'dex\classes.dex'), 'classes.dex',
            [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    } finally { $zip.Dispose() }

    # ---------- 5.5 包内路径断言 ----------
    Step "校验包内路径"
    $chk = [System.IO.Compression.ZipFile]::OpenRead((Join-Path (Get-Location) 'base.apk'))
    $badNames = @($chk.Entries |
        Where-Object { $_.FullName.IndexOf([char]92) -ge 0 } |
        ForEach-Object { $_.FullName })
    $chk.Dispose()
    if ($badNames.Count -gt 0) {
        Fail ("包内存在反斜杠路径（WebView 会找不到文件）: " + $badNames[0])
    }
    Write-Host "  所有条目使用 / 分隔"

    # ---------- 6. 对齐 ----------
    Step "zipalign"
    & $zipalign -f -p 4 base.apk aligned.apk
    if ($LASTEXITCODE -ne 0) { Fail "zipalign 失败" }

    # ---------- 7. 签名 ----------
    Step "签名"
    $ksDir = Join-Path $Root 'keystore'
    New-Item -ItemType Directory -Force -Path $ksDir | Out-Null
    $ks = Join-Path $ksDir 'catledger.jks'
    if (-not (Test-Path $ks)) {
        Write-Host "  生成自签名证书（个人安装用）"
        & $keytool -genkeypair -v -keystore $ks -alias catledger `
            -keyalg RSA -keysize 2048 -validity 10000 `
            -storepass $KsPass -keypass $KsPass `
            -dname "CN=CatLedger, OU=Personal, O=CatLedger, L=Beijing, ST=Beijing, C=CN" *> $null
        if (-not (Test-Path $ks)) { Fail "生成 keystore 失败" }
    }

    & $apksigner sign `
        --ks $ks --ks-key-alias catledger `
        --ks-pass "pass:$KsPass" --key-pass "pass:$KsPass" `
        --min-sdk-version 24 `
        --out catledger-signed.apk aligned.apk
    if ($LASTEXITCODE -ne 0) { Fail "apksigner 签名失败" }

    Step "校验签名"
    & $apksigner verify --min-sdk-version 24 --print-certs catledger-signed.apk
    if ($LASTEXITCODE -ne 0) { Fail "签名校验失败" }
}
finally {
    Pop-Location
}

# ---------- 8. 产出 ----------
$outDir = Join-Path $Root 'apk'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$final = Join-Path $outDir ("catledger-{0}.apk" -f $VersionName)
Copy-Item (Join-Path $Work 'catledger-signed.apk') $final -Force

Step "完成"
Write-Host ("  APK   : {0}" -f $final) -ForegroundColor Green
Write-Host ("  大小  : {0:N2} MB" -f ((Get-Item $final).Length / 1MB)) -ForegroundColor Green
Write-Host ("  SHA256: " + (Get-FileHash $final -Algorithm SHA256).Hash)

Step "清单信息"
Push-Location $Work
try {
    & $aapt2.FullName dump badging 'catledger-signed.apk' 2>&1 |
        Select-String -Pattern '^package:|application-label:|sdkVersion|targetSdkVersion|launchable-activity' |
        ForEach-Object { Write-Host ("  " + $_.Line) }
}
finally { Pop-Location }
exit 0
