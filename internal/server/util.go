package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// M is a JSON object.
type M = map[string]any

// asMap returns v as an object, or an empty one.
func asMap(v any) M {
	if m, ok := v.(M); ok {
		return m
	}
	return M{}
}

func decode(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	return v
}

func sget(m M, k string) string {
	s, _ := m[k].(string)
	return s
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case M:
		return len(x) > 0
	case []any:
		return len(x) > 0
	}
	return true
}

// same compares two decoded JSON values (match ids).
func same(a, b any) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

// py renders a value the way the Python server's log lines did (None, True,
// 'x'), so existing log readers keep working.
func py(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case bool:
		if x {
			return "True"
		}
		return "False"
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprint(int64(x))
		}
		return fmt.Sprint(x)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func pyList(xs []string) string {
	sort.Strings(xs)
	q := make([]string, len(xs))
	for i, x := range xs {
		q[i] = "'" + x + "'"
	}
	return "[" + strings.Join(q, ", ") + "]"
}

func shortID() string {
	b := make([]byte, 2)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
