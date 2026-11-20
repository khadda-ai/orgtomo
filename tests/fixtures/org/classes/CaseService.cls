/**
 * @description Business logic for Case escalation.
 */
public with sharing class CaseService {
    public static void applyEscalation(List<Case> cases) {
        for (Case c : cases) {
            if (c.Priority == 'High' && c.Escalation_Reason__c == null) {
                c.Escalation_Reason__c = 'Auto';
            }
        }
    }

    public static List<Case> openCases(Set<Id> accountIds) {
        return [SELECT Id, Subject, Escalation_Reason__c FROM Case WHERE AccountId IN :accountIds AND IsClosed = false];
    }
}
