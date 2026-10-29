//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

const isWindows = true

var goos = runtime.GOOS

// nativeArch is the machine's own architecture, also when this 32-bit launcher runs under
// emulation (WOW64 on x64, or x86 emulation on Windows on ARM).
func nativeArch() string {
	var process, native uint16
	if err := windows.IsWow64Process2(windows.CurrentProcess(), &process, &native); err == nil {
		switch native {
		case 0xAA64: // IMAGE_FILE_MACHINE_ARM64
			return "arm64"
		case 0x8664: // IMAGE_FILE_MACHINE_AMD64
			return "amd64"
		case 0x014C: // IMAGE_FILE_MACHINE_I386
			return "386"
		}
	}
	// Before Windows 10 1709 (no ARM64 Windows then either): a 32-bit process on 64-bit Windows says so here.
	if os.Getenv("PROCESSOR_ARCHITEW6432") == "AMD64" || os.Getenv("PROCESSOR_ARCHITECTURE") == "AMD64" {
		return "amd64"
	}
	return runtime.GOARCH
}

func holdSignals()    {}
func releaseSignals() {}

// runServer runs the server with this process's stdin, stdout and stderr and exits with its code.
// Windows has no exec, so the launcher stays as the parent; a job object that kills its processes
// when the launcher's handle closes ties the server to the launcher, however the launcher ends.
func runServer(path string, args, env []string) error {
	job, jobErr := killOnCloseJob()
	cmd := exec.Command(path, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = env
	if err := cmd.Start(); err != nil {
		return err
	}
	if jobErr == nil {
		if handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid)); err == nil {
			_ = windows.AssignProcessToJobObject(job, handle)
			windows.CloseHandle(handle)
		}
	}
	err := cmd.Wait()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		os.Exit(exit.ExitCode())
	}
	return err
}

// killOnCloseJob creates a job object whose processes end when its last handle closes: the
// launcher holds that handle until it exits, or the system closes it when the launcher is killed.
func killOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}
