#!/bin/sh
# Installs the `orbyn` command on macOS from a GitHub release, without the desktop app.
#
#   curl -fsSL https://raw.githubusercontent.com/orbyn-dev/orbyn-engineering/main/scripts/install.sh | sh
#
# ORBYN_VERSION=1.2.3 pins an exact release; ORBYN_CHANNEL=nightly takes the nightly
# release instead of the latest stable one. The command and its service go to
# ~/.local/share/orbyn/cli and a small launcher to ~/.local/bin/orbyn
# (ORBYN_INSTALL_DIR and ORBYN_HOME move them). The archive must match its .sha256.
# On Windows, use install.ps1.
set -eu

repo="orbyn-dev/orbyn-engineering"
base="${ORBYN_INSTALL_BASE:-https://github.com/$repo/releases}"
bin="${ORBYN_INSTALL_DIR:-$HOME/.local/bin}"
home="${ORBYN_HOME:-$HOME/.local/share/orbyn}"
channel="${ORBYN_CHANNEL:-stable}"
version="${ORBYN_VERSION:-}"

fail() {
  echo "orbyn install: $*" >&2
  exit 1
}

if [ -n "$version" ]; then
  url="$base/download/v${version#v}"
else
  case "$channel" in
    stable) url="$base/latest/download" ;;
    nightly) url="$base/download/nightly" ;;
    *) fail "ORBYN_CHANNEL must be stable or nightly, not '$channel'." ;;
  esac
fi

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) target="aarch64-apple-darwin" ;;
  Darwin/x86_64) target="x86_64-apple-darwin" ;;
  Darwin/*) fail "this Mac's processor ($(uname -m)) has no build." ;;
  *) fail "this script installs on macOS; on Windows run install.ps1." ;;
esac

asset="orbyn-cli-$target.tar.gz"
work="$(mktemp -d "${TMPDIR:-/tmp}/orbyn-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM

echo "Downloading $url/$asset"
curl -fsSL --proto '=https,http' -o "$work/$asset" "$url/$asset" ||
  fail "could not download $asset. Is there a release for this channel or version?"
curl -fsSL --proto '=https,http' -o "$work/$asset.sha256" "$url/$asset.sha256" ||
  fail "could not download $asset.sha256."

expected="$(cut -d ' ' -f 1 < "$work/$asset.sha256" | tr -d '\r\n')"
actual="$(shasum -a 256 "$work/$asset" | cut -d ' ' -f 1)"
[ -n "$expected" ] && [ "$expected" = "$actual" ] ||
  fail "$asset does not match its checksum; nothing was installed."

mkdir -p "$work/cli"
tar -xzf "$work/$asset" -C "$work/cli"
[ -x "$work/cli/orbyn" ] && [ -x "$work/cli/orbynd" ] ||
  fail "$asset does not hold orbyn and orbynd; nothing was installed."

mkdir -p "$home" "$bin"
rm -rf "$home/cli.old"
[ ! -e "$home/cli" ] || mv "$home/cli" "$home/cli.old"
mv "$work/cli" "$home/cli"
rm -rf "$home/cli.old"

# A launcher rather than a link, so `orbyn` finds `orbynd` and the UI beside itself.
cat > "$bin/orbyn" <<EOF
#!/bin/sh
exec "$home/cli/orbyn" "\$@"
EOF
chmod 755 "$bin/orbyn"

echo "Installed $("$bin/orbyn" --version 2>/dev/null || echo orbyn) to $bin/orbyn"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add $bin to your PATH to run orbyn from any folder." ;;
esac
