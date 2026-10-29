//go:build !windows

package main

import (
	"os/signal"
	"runtime"
	"syscall"
)

const isWindows = false

var goos = runtime.GOOS

func nativeArch() string { return runtime.GOARCH }

var heldSignals = []syscall.Signal{syscall.SIGTERM, syscall.SIGHUP, syscall.SIGINT}

func holdSignals() {
	for _, s := range heldSignals {
		signal.Ignore(s)
	}
}

// releaseSignals restores the defaults: an ignored signal would stay ignored in the exec'd server.
func releaseSignals() {
	for _, s := range heldSignals {
		signal.Reset(s)
	}
}

// runServer replaces this process with the server, so Claude Code talks to it directly.
func runServer(path string, args, env []string) error {
	return syscall.Exec(path, append([]string{path}, args...), env)
}
