// Command wicket starts the Wicket MCP server for Claude Code, with nothing installed first.
//
// The plugin carries this launcher (server/wicket on macOS, server/wicket.exe on Windows) and no
// server: the server is a self-contained build per platform, too large for the plugin's git repo.
// On the first start the launcher downloads the build for this platform from the GitHub release
// matching the plugin version, checks it against server/SHA256SUMS (committed with the plugin), and
// unpacks it into server/bin/<version>/. Every later start runs that copy without touching the
// network. A development build placed there by `bun run plugin:build` is used as it is.
//
// stdout is the MCP channel: everything the launcher says goes to stderr.
package main

import (
	"archive/zip"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const defaultReleases = "https://github.com/davesmith7403/wicket/releases/download/"

// maxDownload caps a release download; a wrong mirror must not fill the disk before the checksum says no.
var maxDownload int64 = 512 << 20

// platformName names the server build for an OS and the machine's own architecture (on Windows the
// OS is asked, so this 32-bit launcher under emulation still picks the native build).
func platformName(goos, native string) (string, error) {
	switch {
	case goos == "darwin" && native == "arm64":
		return "darwin-arm64", nil
	case goos == "darwin":
		return "", errors.New("Wicket runs on Apple silicon Macs; Intel Macs are not supported")
	case goos == "windows" && native == "arm64":
		return "windows-arm64", nil
	case goos == "windows" && native == "amd64":
		return "windows-x64", nil
	case goos == "windows" && native == "386":
		return "", errors.New("Wicket needs 64-bit Windows; 32-bit Windows is not supported")
	}
	return "", fmt.Errorf("Wicket has no server build for %s/%s", goos, native)
}

// readVersion reads the plugin version from <root>/.claude-plugin/plugin.json.
func readVersion(root string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(root, ".claude-plugin", "plugin.json"))
	if err != nil {
		return "", fmt.Errorf("cannot read the plugin version: %w", err)
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil || manifest.Version == "" {
		return "", fmt.Errorf("plugin.json has no version")
	}
	return manifest.Version, nil
}

// parseSums reads `sha256sum` output: "<hex>  <file name>" per line.
func parseSums(text string) map[string]string {
	sums := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 {
			sums[strings.TrimPrefix(fields[1], "*")] = strings.ToLower(fields[0])
		}
	}
	return sums
}

// serverFileName is the server executable's name inside a release zip and in server/bin/<version>/.
func serverFileName() string {
	if isWindows {
		return "wicket-server.exe"
	}
	return "wicket-server"
}

// downloadURL is the release asset's address; base (WICKET_RELEASES) replaces GitHub, e.g. for a mirror.
func downloadURL(base, version, file string) string {
	if base == "" {
		base = defaultReleases
	}
	return strings.TrimSuffix(base, "/") + "/v" + version + "/" + file
}

// ensureServer returns the path of this platform's server for the plugin at root, downloading it
// on first use. Progress goes to logw.
func ensureServer(root, platform, base string, client *http.Client, logw io.Writer) (string, error) {
	version, err := readVersion(root)
	if err != nil {
		return "", err
	}
	binDir := filepath.Join(root, "server", "bin")
	target := filepath.Join(binDir, version, serverFileName())
	if _, err := os.Stat(target); err == nil {
		return target, nil
	}

	zipName := fmt.Sprintf("wicket-server-%s-%s.zip", version, platform)
	sumsText, err := os.ReadFile(filepath.Join(root, "server", "SHA256SUMS"))
	if err != nil {
		return "", fmt.Errorf("cannot read server/SHA256SUMS: %w", err)
	}
	want, ok := parseSums(string(sumsText))[zipName]
	if !ok {
		return "", fmt.Errorf("this plugin version has no server build for %s (%s)", platform, zipName)
	}

	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return "", err
	}
	partial := filepath.Join(binDir, ".download-"+version+"-"+platform+".partial")
	sweep(binDir, filepath.Base(partial))

	// The zip is fetched into a fixed partial file that a later start resumes: Claude Code gives a
	// server 30 seconds, so on a slow line the first start may be killed mid-download.
	url := downloadURL(base, version, zipName)
	fmt.Fprintf(logw, "wicket: first start of %s: downloading the Wicket server for %s\n", version, platform)
	if err := download(client, url, partial, want); err != nil {
		return "", err
	}
	// Unpacked beside its final place and renamed in, so nothing half-written ever looks complete.
	work, err := os.MkdirTemp(binDir, ".unpack-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	if err := unzipServer(partial, work); err != nil {
		return "", err
	}
	final := filepath.Dir(target)
	if _, err := os.Stat(target); err == nil {
		os.Remove(partial)
		return target, nil // another start finished first; its copy is as good as ours
	}
	// A version folder without its server (quarantined, deleted) would block the rename for good.
	os.RemoveAll(final)
	if err := renameWithRetry(work, final); err != nil {
		if _, statErr := os.Stat(target); statErr == nil {
			os.Remove(partial)
			return target, nil
		}
		return "", err
	}
	os.Remove(partial)
	fmt.Fprintf(logw, "wicket: server %s ready\n", version)
	return target, nil
}

// sweep removes what earlier starts left in bin/ (unpack folders, other partial downloads).
func sweep(binDir, keep string) {
	entries, _ := os.ReadDir(binDir)
	for _, e := range entries {
		name := e.Name()
		if name != keep && (strings.HasPrefix(name, ".download-") || strings.HasPrefix(name, ".unpack-")) {
			os.RemoveAll(filepath.Join(binDir, name))
		}
	}
}

// renameWithRetry renames, retrying briefly: on Windows a virus scanner may still hold the new file.
func renameWithRetry(from, to string) error {
	var err error
	for attempt := 0; attempt < 10; attempt++ {
		if err = os.Rename(from, to); err == nil {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return err
}

// download fetches url into path, resuming what an earlier start left there, and checks the whole
// file's SHA-256 against want. A file that does not match is removed, so the next start begins afresh.
func download(client *http.Client, url, path, want string) error {
	var have int64
	if info, err := os.Stat(path); err == nil {
		have = info.Size()
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("could not download the Wicket server from %s: %w", url, err)
	}
	defer res.Body.Close()
	flags := os.O_CREATE | os.O_WRONLY
	switch {
	case res.StatusCode == http.StatusPartialContent && have > 0:
		flags |= os.O_APPEND
	case res.StatusCode == http.StatusRequestedRangeNotSatisfiable && have > 0:
		flags = -1 // nothing more to fetch: the partial file is complete
	case res.StatusCode == http.StatusOK:
		flags |= os.O_TRUNC
		have = 0
	default:
		return fmt.Errorf("could not download the Wicket server from %s: HTTP %d", url, res.StatusCode)
	}
	if flags != -1 {
		out, err := os.OpenFile(path, flags, 0o644)
		if err != nil {
			return err
		}
		n, copyErr := io.Copy(out, io.LimitReader(res.Body, maxDownload-have+1))
		closeErr := out.Close()
		if copyErr != nil {
			return fmt.Errorf("the download from %s broke off (the next start resumes it): %w", url, copyErr)
		}
		if closeErr != nil {
			return closeErr
		}
		if have+n > maxDownload {
			os.Remove(path)
			return fmt.Errorf("the download from %s is larger than any Wicket server; it was discarded", url)
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, hashErr := io.Copy(hash, file)
	file.Close()
	if hashErr != nil {
		return hashErr
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != want {
		os.Remove(path)
		return fmt.Errorf("the download from %s does not match its checksum (got %s, expected %s); it was discarded", url, got, want)
	}
	return nil
}

// unzipServer extracts the server executable from the release zip into dir.
func unzipServer(zipPath, dir string) error {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("the downloaded server is not a valid zip: %w", err)
	}
	defer reader.Close()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, file := range reader.File {
		if file.Name != serverFileName() {
			continue
		}
		in, err := file.Open()
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(filepath.Join(dir, file.Name), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
	return fmt.Errorf("the downloaded zip has no %s", serverFileName())
}

func main() {
	self, err := os.Executable()
	if err != nil {
		fail(err)
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	root := filepath.Dir(filepath.Dir(self))
	platform, err := platformName(goos, nativeArch())
	if err != nil {
		fail(err)
	}
	client := &http.Client{Timeout: 10 * time.Minute}
	// A first start may outlast Claude Code's 30-second wait: finish the download anyway, so the
	// next start (a reconnect) finds the server in place.
	holdSignals()
	server, err := ensureServer(root, platform, os.Getenv("WICKET_RELEASES"), client, os.Stderr)
	releaseSignals()
	if err != nil {
		fail(err)
	}
	env := append(os.Environ(), "WICKET_SKILL_DIR="+filepath.Join(root, "skills", "wicket-usage"))
	fail(runServer(server, os.Args[1:], env))
}

func fail(err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "wicket: %v\n", err)
		os.Exit(1)
	}
	os.Exit(0)
}
