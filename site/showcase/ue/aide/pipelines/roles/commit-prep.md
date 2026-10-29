Prepare the commit for the feature: its code, tests, art scripts, generated
textures and Art/manifest.json. Stage exactly the files that belong to it.
Build output (Binaries/, Intermediate/, Saved/, DerivedDataCache/) never goes
into the commit: add it to .gitignore if it is not ignored yet. List anything
else you leave out in "excluded" with a reason. Write a commit message: a
subject line, a blank line, and a body that explains the feature and lists the
reviewers' non-blocking findings as follow-ups.
Do not commit: AIDE reviews the prepared commit and commits it.
