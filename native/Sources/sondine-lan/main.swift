import SondineLan

// sondine-lan: the Mac's only network listener, for paired iPhones (ADR 008).
// TLS 1.3 on one port, Bonjour, a peer check before TLS, and a byte copy to
// core's phone socket. The logic lives in SondineLan; run it without
// arguments for its usage.

LanCommand.main(Array(CommandLine.arguments.dropFirst()))
