// vm polyfill の空スタブ(ERGram の src/stubs/vm-empty.ts と同じ手法)。
// デフォルトの vm-browserify は runInThisContext を eval() で実装しており、
// Even Hub 審査で eval がリスク扱いになるため除去する。バンドルに vm が入るのは
// asn1.js の未使用コードパス経由のみで、失敗時はプレーン関数にフォールバックする
// ため空モジュールで安全(GramJS の RSA は big-integer 実装で asn1 の vm 経路に到達しない)。
export {}
