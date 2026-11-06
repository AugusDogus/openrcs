// Command crypto generates and checks the libgm crypto parity fixtures used by
// src/lib/gm/crypto/*.test.ts. See README.md for how to run it.
package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "gen":
		fs := flag.NewFlagSet("gen", flag.ExitOnError)
		out := fs.String("out", "../../../src/lib/gm/__fixtures__", "directory to write crypto-*.json fixtures into")
		_ = fs.Parse(os.Args[2:])
		if err := generate(*out); err != nil {
			fmt.Fprintln(os.Stderr, "gen failed:", err)
			os.Exit(1)
		}
	case "verify":
		fs := flag.NewFlagSet("verify", flag.ExitOnError)
		in := fs.String("in", "", "JSON file written by emit-ts-outputs.ts")
		_ = fs.Parse(os.Args[2:])
		if *in == "" {
			usage()
		}
		if err := verify(*in); err != nil {
			fmt.Fprintln(os.Stderr, "verify failed:", err)
			os.Exit(1)
		}
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: crypto gen [-out dir] | crypto verify -in ts-outputs.json")
	os.Exit(2)
}
