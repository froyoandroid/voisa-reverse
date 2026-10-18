// Command voisa serves the Voisa web UI: the single page, its REST API and
// the /ws channel. It binds localhost only; nginx terminates TLS in front.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"voisa/internal/server"
)

func main() {
	host := flag.String("host", "127.0.0.1", "localhost only (do not change)")
	port := flag.Int("port", 8765, "port")
	root := flag.String("root", ".", "project root: ui/ (and the data, unless -data is set)")
	data := flag.String("data", "", "data directory: users/ and voisa.log (default: -root)")
	flag.Parse()

	if *host != "127.0.0.1" && *host != "localhost" && *host != "::1" {
		fmt.Printf("refusing to bind %s: this UI is localhost-only\n", *host)
		os.Exit(2)
	}
	addr := fmt.Sprintf("%s:%d", *host, *port)
	srv := &http.Server{Addr: addr, Handler: server.New(*root, *data), ReadHeaderTimeout: 10 * time.Second}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		// let every leg leave its match (close-dialog, stop-search) first
		server.CloseAll()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	fmt.Printf("Voisa local UI -> http://%s  (localhost only)\n", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
