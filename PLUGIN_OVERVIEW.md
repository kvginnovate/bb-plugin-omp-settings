Read and write every omp CLI setting (the oh-my-pi coding agent) from bb —
one page, one command, one tool. Open the "omp settings" entry in bb's
sidebar and you get every setting a typical install exposes (~530 of them):
the right control per type — toggles, dropdowns, a JSON editor for arrays
and records, search, and a "modified" filter that shows exactly what you've
touched. The same five operations (`list`, `get`, `set`, `reset`, `info`)
work from the `bb omp-settings` CLI on any host you target, and from the
`omp_settings` agent tool inside threads.

*One rule to remember:* `set` replaces the whole value — it never merges.
To change part of a record or array, send the complete new value, and read
back the result.
