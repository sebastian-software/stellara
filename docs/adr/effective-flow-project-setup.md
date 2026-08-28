# Effective Flow project setup

## Status

Active

## Context

This ADR holds this project's tracked Effective Flow configuration. `.effective-flow/` is a pure runtime directory and completely gitignored.

## Configuration

| Key                                      | Value                      |
| ---------------------------------------- | -------------------------- |
| review.profile                           | focused                    |
| review.autoConfirmScope                  | true                       |
| review.designDecisionSources             | standard                   |
| review.validation                        | full                       |
| applyReview.defaultCommitStrategy        | worktrees                  |
| applyReview.finalValidation              | full                       |
| applyReview.stashPolicy                  | interactive                |
| applyReview.worktree.baseDir              | .effective-flow/.worktrees |
| applyReview.worktree.setup                | auto                       |
| worktree.enabled                          | true                       |
| worktree.setup                            | auto                       |
| worktree.baseDir                          | .effective-flow/.worktrees |
| delivery.completion                       | pr                         |
| delivery.baseBranch                       | origin/main                |
| delivery.prReview                         | always                     |
| delivery.branchPrefix                     | effective-flow             |
| delivery.returnBranch                     | auto                       |
| delivery.mergeMethod                      | squash                     |
| tracker.mode                              | remote                     |
| tracker.remoteToolOverride                | auto                       |
| plan.dir                                  | docs/plan                  |
| concept.dir                               | docs/concept               |
| language.project                          | en                         |
| skills.enabled                            | true                       |
| skills.include                            | (empty)                    |
| skills.exclude                            | (empty)                    |
| mergeGate.completion                      | merge                      |
| mergeGate.conflictResolution              | auto                       |
| mergeGate.requireAllChecks                | true                       |
| mergeGate.checkWaitMinutes                | 20                         |
| mergeGate.maxRounds                       | 10                         |
| mergeGate.botWaitMinutes                  | 10                         |
| mergeGate.bots                            | recensor                   |
| mergeGate.bots.recensor.trigger           | /recensor review           |
| mergeGate.bots.recensor.check             | recensor/review            |
