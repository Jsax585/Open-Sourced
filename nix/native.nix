{
  cmake,
  craneLib,
  lib,
  ninja,
  pipewire,
  pkg-config,
  rustPlatform,
  source,
  stdenv,
  # Off by default: see the flag's docs in package.nix. The pipewire crate's
  # build script pkg-config's and links system libpipewire-0.3 here.
  withWaylandScreencast ? false,
}:
let
  platform = import ./platform.nix stdenv.hostPlatform.system;
  commonArgs = {
    pname = "pi-natives";
    version = (lib.importTOML ../Cargo.toml).workspace.package.version;

    # Cargo needs more than Rust sources: tokenizer tables (include_bytes!),
    # the sublime-syntax corpus the build script packs, fonts, pi-shell's
    # minimizer *.toml defs, and the vendored [patch.crates-io] trees
    # (including tree-sitter's C grammar). .cargo/config.toml pins Ninja as
    # the cmake generator and a nightly-only unstable flag. Keeping all of
    # crates/ still drops the TS packages, so revs that don't touch Rust
    # don't rebuild Rust.
    src = lib.cleanSourceWith {
      src = source;
      filter =
        path: type:
        let
          relative = lib.removePrefix (toString source + "/") (toString path);
        in
        lib.hasPrefix "crates/" relative
        || lib.hasPrefix ".cargo/" relative
        # builtins.path prunes a directory's whole subtree when the directory
        # entry itself fails the filter, so match it as well.
        || relative == "crates"
        || relative == ".cargo"
        || (builtins.baseNameOf path == "Cargo.toml")
        || (builtins.baseNameOf path == "Cargo.lock");
    };

    strictDeps = true;
    nativeBuildInputs = [
      cmake
      ninja
      pkg-config
      rustPlatform.bindgenHook
    ];
    buildInputs = lib.optionals withWaylandScreencast [ pipewire ];

    env = {
      CMAKE_POLICY_VERSION_MINIMUM = "3.5";
      PCRE2_SYS_STATIC = "1";
      SOURCE_DATE_EPOCH = "1";
    }
    // lib.optionalAttrs (platform ? rustFlags) { RUSTFLAGS = platform.rustFlags; };

    cargoExtraArgs =
      "--locked -p pi-natives" + lib.optionalString withWaylandScreencast " --features wayland-pipewire";
  };
in
craneLib.buildPackage (
  commonArgs
  // {
    # No deps layer: crane's buildPackage implicitly pre-builds one (with
    # mkDummySrc stubbing every workspace member's lib.rs), but the members
    # are also the [patch.crates-io] targets (vendored cfg_aliases etc.), so
    # third-party build scripts would link the empty stubs (nix 0.28's
    # build.rs fails with "no cfg_aliases in the root"). Release bumps change
    # workspace versions in Cargo.toml/Cargo.lock anyway, which would re-key
    # a deps layer every time — the src filter above is the caching win.
    cargoArtifacts = null;
    # crane otherwise defaults to running cargo test, which the packaged build
    # never did.
    doCheck = false;
    # pi-natives is a cdylib, so crane's default install (binaries from the
    # cargo build log) finds nothing to install; ship the library itself.
    installPhaseCommand = ''
      install -Dm755 "target/release/${platform.nativeLibrary}" "$out/${platform.nativeLibrary}"
    '';
  }
)
