# Shared by package.nix (embeds the prebuilt addon) and native.nix (builds
# it): the napi addon filename, the cdylib output name, and per-platform
# RUSTFLAGS.
system:
{
  aarch64-darwin = {
    addon = "pi_natives.darwin-arm64.node";
    nativeLibrary = "libpi_natives.dylib";
  };
  aarch64-linux = {
    addon = "pi_natives.linux-arm64.node";
    nativeLibrary = "libpi_natives.so";
  };
  x86_64-darwin = {
    addon = "pi_natives.darwin-x64-baseline.node";
    nativeLibrary = "libpi_natives.dylib";
    rustFlags = "-C target-cpu=x86-64-v2";
  };
  x86_64-linux = {
    addon = "pi_natives.linux-x64-baseline.node";
    nativeLibrary = "libpi_natives.so";
    rustFlags = "-C target-cpu=x86-64-v2";
  };
}
.${system} or (throw "Unsupported OMP platform: ${system}")
