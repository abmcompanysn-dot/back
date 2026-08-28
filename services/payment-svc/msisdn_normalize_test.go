package main

import "testing"

func TestNormalizeMSISDN_Benin(t *testing.T) {
	cases := map[string]string{
		"0190010203":         "2290190010203", // national 10 chiffres
		"+229 01 90 01 02 03": "2290190010203", // international avec +
		"00229 0190010203":   "2290190010203", // 00 + indicatif
		"2290190010203":      "2290190010203", // déjà normalisé
		"90010203":           "2290190010203", // ancien 8 chiffres
		"0229 0190010203":    "2290190010203", // 0 de liaison
	}
	for in, want := range cases {
		if got := normalizeMSISDN(in, "229"); got != want {
			t.Errorf("normalizeMSISDN(%q,229) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeMSISDN_Senegal(t *testing.T) {
	cases := map[string]string{
		"771234567":      "221771234567",
		"0771234567":     "221771234567",
		"+221771234567":  "221771234567",
		"221771234567":   "221771234567",
		"00221771234567": "221771234567",
	}
	for in, want := range cases {
		if got := normalizeMSISDN(in, "221"); got != want {
			t.Errorf("normalizeMSISDN(%q,221) = %q, want %q", in, got, want)
		}
	}
}
