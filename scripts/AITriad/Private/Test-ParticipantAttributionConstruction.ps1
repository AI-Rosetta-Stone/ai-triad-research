# Copyright (c) 2026 Jeffrey Snover. All rights reserved.
# Licensed under the MIT License. See LICENSE file in the project root.

# t/4876 (CL spec t/4876#1): mechanical post-check for the participant-attribution construction.
# Invoke-OrgStanceExtraction's prompt already tells the model to exclude "findings a sentence itself
# attributes to survey participants, respondents, interviewees or an elicitation", but 4 of 18
# legal-policy-approaches claims across t/4383 gate runs 5-7 were exactly that construction anyway --
# same lesson as t/4742's camp-bridge filter: a prose rule that doesn't fully hold, plus a construction
# you can detect mechanically. Code filters the output now, rather than asking the model a third time.
$script:ParticipantAttributionNoun = '(?:participants?|respondents?|interviewees?|experts?\s+(?:surveyed|consulted|interviewed))'
$script:ParticipantAttributionVerb = '(?:became|did\s+not|didn''t|rated|ranked|felt|believed|considered|agreed|disagreed|expressed|conveyed?|judged|viewed|saw|reported|indicated|preferred|favou?red|were\s+(?:more|less|skeptical|optimistic|divided))'
$script:ParticipantAttributionPatterns = @(
    # 1. "in the views of / according to / per (the) <participant-noun>"
    "\b(?:in\s+the\s+views?\s+of|according\s+to|per)\s+(?:the\s+)?$script:ParticipantAttributionNoun"
    # 2. "<participant-noun> ... <view/finding verb>" -- participant as holder of a view or finding
    "\b$script:ParticipantAttributionNoun\b(?:\s+\w+){0,6}?\s+$script:ParticipantAttributionVerb\b"
    # 3. "emerged from the elicitation/survey/interviews/workshop"
    '\bemerged\s+from\s+the\s+(?:elicitation|survey|interviews|workshop)'
    # 4. "elicitation/survey results/findings/participants show/indicate/suggest"
    '\b(?:elicitation|survey)\s+(?:results|findings|participants)\s+(?:show|showed|indicate|indicated|suggest|suggested)'
)

function Test-ParticipantAttributionConstruction {
    <#
    .SYNOPSIS
        The matched substring if $Text attributes its finding to survey participants, respondents,
        interviewees or an elicitation (t/4876), else $null.
    .DESCRIPTION
        Calibrated by CL against 123 unique claims pooled from t/4383 gate runs 5-7 (t/4876#1):
        3 of 3 known participant-sourced findings caught, 0 false positives on the other 120 --
        including 2 claims that name participants as the ordinary subject of a method recommendation
        rather than as the source of a reported finding, which is why the pattern requires a view/
        finding verb, not just the noun. CL's own caveat: calibrated on one document's positives
        (n = 3), not human-validated at scale -- re-measure after the t/4383 item-2 re-extraction runs
        on the full corpus, and narrow the verb set first if precision drops there.
    #>
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    foreach ($Pattern in $script:ParticipantAttributionPatterns) {
        $Match = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if ($Match.Success) { return $Match.Value }
    }
    return $null
}
