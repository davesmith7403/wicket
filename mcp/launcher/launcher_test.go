package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPlatformName(t *testing.T) {
	// The second argument is the machine's own architecture (on Windows asked of the OS, so the
	// 32-bit launcher under emulation on Windows on ARM still picks the arm64 server).
	cases := []struct{ goos, native, want string }{
		{"darwin", "arm64", "darwin-arm64"},
		{"windows", "amd64", "windows-x64"},
		{"windows", "arm64", "windows-arm64"},
	}
	for _, c := range cases {
		got, err := platformName(c.goos, c.native)
		if err != nil || got != c.want {
			t.Errorf("platformName(%s, %s) = %q, %v; want %q", c.goos, c.native, got, err, c.want)
		}
	}
	if _, err := platformName("darwin", "amd64"); err == nil || !strings.Contains(err.Error(), "Intel") {
		t.Errorf("an Intel Mac must be refused in words, got %v", err)
	}
	if _, err := platformName("windows", "386"); err == nil || !strings.Contains(err.Error(), "32-bit") {
		t.Errorf("32-bit Windows must be refused in words, got %v", err)
	}
}

func TestReadVersion(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".claude-plugin", "plugin.json"), `{"name":"wicket","version":"2.5.0"}`)
	got, err := readVersion(root)
	if err != nil || got != "2.5.0" {
		t.Fatalf("readVersion = %q, %v", got, err)
	}
}

func TestParseSums(t *testing.T) {
	sums := parseSums("abc123  wicket-server-2.5.0-darwin-arm64.zip\n\ndef456  wicket-server-2.5.0-windows-x64.zip\n")
	if sums["wicket-server-2.5.0-windows-x64.zip"] != "def456" || len(sums) != 2 {
		t.Fatalf("parseSums = %v", sums)
	}
}

// fixture builds a plugin folder with a release zip for this platform served by an httptest server.
type fixture struct {
	root     string
	platform string
	zipName  string
	zip      []byte
	hits     atomic.Int32
	ranges   []string
	noRange  bool
	server   *httptest.Server
}

func newFixture(t *testing.T, sumOverride string) *fixture {
	t.Helper()
	f := &fixture{root: t.TempDir(), platform: "test-platform"}
	f.zipName = "wicket-server-2.5.0-" + f.platform + ".zip"
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create(serverFileName())
	w.Write(bytes.Repeat([]byte("#!/bin/sh\necho server\n"), 200))
	zw.Close()
	f.zip = buf.Bytes()
	sum := sha256.Sum256(f.zip)
	hexSum := hex.EncodeToString(sum[:])
	if sumOverride != "" {
		hexSum = sumOverride
	}
	writeFile(t, filepath.Join(f.root, ".claude-plugin", "plugin.json"), `{"version":"2.5.0"}`)
	writeFile(t, filepath.Join(f.root, "server", "SHA256SUMS"), hexSum+"  "+f.zipName+"\n")
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		if r.URL.Path != "/v2.5.0/"+f.zipName {
			http.NotFound(w, r)
			return
		}
		if rng := r.Header.Get("Range"); rng != "" && !f.noRange {
			f.ranges = append(f.ranges, rng)
			http.ServeContent(w, r, f.zipName, time.Time{}, bytes.NewReader(f.zip))
			return
		}
		w.Write(f.zip)
	}))
	t.Cleanup(f.server.Close)
	return f
}

// deadPid and livePid stand for another start's process id: ended, and still running.
const (
	deadPid = 999999001
	livePid = 999999002
)

func init() {
	ownerAlive = func(pid int) bool { return pid == livePid }
}

// partial is the download a start that has ended (killed mid-download) left behind.
func (f *fixture) partial() string {
	return f.partialOf(deadPid)
}

func (f *fixture) partialOf(pid int) string {
	return filepath.Join(f.root, "server", "bin", fmt.Sprintf(".download-2.5.0-%s.%d-1.partial", f.platform, pid))
}

func age(t *testing.T, path string, by time.Duration) {
	t.Helper()
	then := time.Now().Add(-by)
	if err := os.Chtimes(path, then, then); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) ensure() (string, error) {
	return ensureServer(f.root, f.platform, f.server.URL+"/", f.server.Client(), &bytes.Buffer{})
}

func TestEnsureServerDownloadsVerifiesAndExtracts(t *testing.T) {
	f := newFixture(t, "")
	path, err := f.ensure()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(f.root, "server", "bin", "2.5.0", serverFileName()); path != want {
		t.Fatalf("path = %s, want %s", path, want)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode()&0o111 == 0 {
		t.Fatalf("server is not executable: %v", info.Mode())
	}
	// The second start uses the extracted server and never touches the network.
	if _, err := f.ensure(); err != nil || f.hits.Load() != 1 {
		t.Fatalf("second ensure: err %v, downloads %d", err, f.hits.Load())
	}
}

func TestEnsureServerRefusesAChecksumMismatchAndLeavesNothing(t *testing.T) {
	f := newFixture(t, strings.Repeat("0", 64))
	_, err := f.ensure()
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("want a checksum error, got %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(f.root, "server", "bin"))
	if len(entries) != 0 {
		t.Fatalf("a refused download left files behind: %v", entries)
	}
}

func TestEnsureServerWithoutASumForThePlatformRefusesBeforeDownloading(t *testing.T) {
	f := newFixture(t, "")
	f.platform = "other-platform"
	_, err := f.ensure()
	if err == nil || !strings.Contains(err.Error(), "other-platform") || f.hits.Load() != 0 {
		t.Fatalf("err %v, downloads %d", err, f.hits.Load())
	}
}

func TestEnsureServerUsesALocalBuildWithoutSums(t *testing.T) {
	// Development: plugin:build puts the host's server in place; there is nothing to download or check.
	root := t.TempDir()
	writeFile(t, filepath.Join(root, ".claude-plugin", "plugin.json"), `{"version":"2.5.0"}`)
	local := filepath.Join(root, "server", "bin", "2.5.0", serverFileName())
	writeFile(t, local, "server")
	path, err := ensureServer(root, "darwin-arm64", "http://127.0.0.1:1/", http.DefaultClient, &bytes.Buffer{})
	if err != nil || path != local {
		t.Fatalf("path %s, err %v", path, err)
	}
}

func TestEnsureServerResumesADownloadThatWasCutOff(t *testing.T) {
	// Claude Code gives a server 30 seconds; on a slow line the first start is killed mid-download.
	f := newFixture(t, "")
	writeFile(t, f.partial(), string(f.zip[:len(f.zip)/2]))
	if _, err := f.ensure(); err != nil {
		t.Fatal(err)
	}
	if len(f.ranges) != 1 || f.ranges[0] != fmt.Sprintf("bytes=%d-", len(f.zip)/2) {
		t.Fatalf("ranges asked: %v", f.ranges)
	}
	if _, err := os.Stat(f.partial()); !os.IsNotExist(err) {
		t.Fatalf("the partial file stayed: %v", err)
	}
}

func TestEnsureServerStartsOverWhenTheServerIgnoresTheRange(t *testing.T) {
	f := newFixture(t, "")
	f.noRange = true
	writeFile(t, f.partial(), string(f.zip[:100]))
	if _, err := f.ensure(); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureServerDropsACorruptPartialAndRecovers(t *testing.T) {
	f := newFixture(t, "")
	writeFile(t, f.partial(), strings.Repeat("x", len(f.zip)/2))
	if _, err := f.ensure(); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("want a checksum error, got %v", err)
	}
	if _, err := f.ensure(); err != nil {
		t.Fatalf("the next start must recover from scratch: %v", err)
	}
}

func TestEnsureServerSweepsLeftoversOfEarlierStarts(t *testing.T) {
	f := newFixture(t, "")
	bin := filepath.Join(f.root, "server", "bin")
	// Left by starts that have ended, and by names without an owner that are older than any start lives.
	ended := []string{
		fmt.Sprintf(".unpack-%d-654321", deadPid),
		fmt.Sprintf(".download-2.4.0-%s.%d-1.partial", f.platform, deadPid),
		".download-123456",
		".unpack-654321",
	}
	for _, debris := range ended {
		writeFile(t, filepath.Join(bin, debris, "junk"), "x")
	}
	age(t, filepath.Join(bin, ".download-123456"), 2*staleAfter)
	age(t, filepath.Join(bin, ".unpack-654321"), 2*staleAfter)
	if _, err := f.ensure(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(bin)
	if len(entries) != 1 || entries[0].Name() != "2.5.0" {
		t.Fatalf("bin holds %v", entries)
	}
}

func TestEnsureServerLeavesARunningStartsFilesAlone(t *testing.T) {
	// A reconnect during a slow first download: the first start is still writing its own files.
	f := newFixture(t, "")
	bin := filepath.Join(f.root, "server", "bin")
	theirPartial := f.partialOf(livePid)
	theirUnpack := filepath.Join(bin, fmt.Sprintf(".unpack-%d-42", livePid), "junk")
	half := string(f.zip[:len(f.zip)/2])
	writeFile(t, theirPartial, half)
	writeFile(t, theirUnpack, "x")
	if _, err := f.ensure(); err != nil {
		t.Fatal(err)
	}
	if len(f.ranges) != 0 {
		t.Fatalf("this start resumed a running start's download: %v", f.ranges)
	}
	if got, err := os.ReadFile(theirPartial); err != nil || string(got) != half {
		t.Fatalf("the running start's download was touched: %v", err)
	}
	if _, err := os.Stat(theirUnpack); err != nil {
		t.Fatalf("the running start's unpack folder was removed: %v", err)
	}
	// Once it is older than any start lives, it goes whatever its owner's id says.
	age(t, theirPartial, 2*staleAfter)
	age(t, filepath.Dir(theirUnpack), 2*staleAfter)
	os.RemoveAll(filepath.Join(bin, "2.5.0"))
	if _, err := f.ensure(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(bin)
	if len(entries) != 1 || entries[0].Name() != "2.5.0" {
		t.Fatalf("bin holds %v", entries)
	}
}

func TestEnsureServerTwoStartsAtOnceBothSucceed(t *testing.T) {
	f := newFixture(t, "")
	// A slow line: each download stops halfway until both starts are downloading.
	var inFlight sync.WaitGroup
	inFlight.Add(2)
	f.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		w.Header().Set("Content-Length", fmt.Sprint(len(f.zip)))
		w.Write(f.zip[:len(f.zip)/2])
		w.(http.Flusher).Flush()
		inFlight.Done()
		inFlight.Wait()
		w.Write(f.zip[len(f.zip)/2:])
	})
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			path, err := f.ensure()
			if err == nil {
				_, err = os.Stat(path)
			}
			errs <- err
		}()
	}
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("a start failed while another was downloading: %v", err)
		}
	}
	entries, _ := os.ReadDir(filepath.Join(f.root, "server", "bin"))
	if f.hits.Load() != 2 || len(entries) != 1 || entries[0].Name() != "2.5.0" {
		t.Fatalf("downloads %d, bin holds %v", f.hits.Load(), entries)
	}
}

func TestPlaceKeepsAnIdenticalServerThatIsAlreadyThere(t *testing.T) {
	// The other start finished first; on Windows its running server cannot be replaced at all.
	dir := t.TempDir()
	work, final := filepath.Join(dir, ".unpack-1-1"), filepath.Join(dir, "2.5.0")
	writeFile(t, filepath.Join(work, serverFileName()), "server")
	writeFile(t, filepath.Join(final, serverFileName()), "server")
	writeFile(t, filepath.Join(final, "marker"), "theirs")
	if err := place(work, final); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(final, "marker")); err != nil {
		t.Fatalf("the copy already in place was replaced: %v", err)
	}
}

func TestPlaceReplacesAServerThatDiffers(t *testing.T) {
	dir := t.TempDir()
	work, final := filepath.Join(dir, ".unpack-1-1"), filepath.Join(dir, "2.5.0")
	writeFile(t, filepath.Join(work, serverFileName()), "server")
	writeFile(t, filepath.Join(final, serverFileName()), "damaged")
	if err := place(work, final); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(final, serverFileName()))
	entries, _ := os.ReadDir(dir)
	if string(got) != "server" || len(entries) != 1 {
		t.Fatalf("server %q, folder holds %v", got, entries)
	}
}

func TestEnsureServerReplacesAVersionFolderWhoseServerIsGone(t *testing.T) {
	// Antivirus quarantined the exe, or someone deleted it: the folder must not block every start.
	f := newFixture(t, "")
	writeFile(t, filepath.Join(f.root, "server", "bin", "2.5.0", "leftover"), "x")
	path, err := f.ensure()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureServerRefusesAnOversizedDownload(t *testing.T) {
	f := newFixture(t, "")
	defer func(old int64) { maxDownload = old }(maxDownload)
	maxDownload = int64(len(f.zip) / 2)
	if _, err := f.ensure(); err == nil || !strings.Contains(err.Error(), "larger") {
		t.Fatalf("want a size error, got %v", err)
	}
}

func TestDownloadURLFollowsTheVersion(t *testing.T) {
	if got := downloadURL("", "2.5.0", "a.zip"); got != "https://github.com/davesmith7403/wicket/releases/download/v2.5.0/a.zip" {
		t.Fatalf("downloadURL = %s", got)
	}
	if got := downloadURL("http://mirror.local/x/", "2.5.0", "a.zip"); got != "http://mirror.local/x/v2.5.0/a.zip" {
		t.Fatalf("override = %s", got)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
