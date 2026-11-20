@IsTest
private class CaseServiceTest {
    @IsTest
    static void appliesEscalationInBulk() {
        List<Case> cases = new List<Case>();
        for (Integer i = 0; i < 200; i++) {
            cases.add(new Case(Subject = 'Orgtomo bulk escalation case ' + i, Priority = 'High'));
        }
        Test.startTest();
        CaseService.applyEscalation(cases);
        Test.stopTest();
        Assert.areEqual('Auto', cases[0].Escalation_Reason__c, 'High priority cases get a reason');
    }
}
