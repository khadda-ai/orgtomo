trigger CaseTrigger on Case (before insert, before update) {
    CaseService.applyEscalation(Trigger.new);
}
