import { LightningElement, wire } from 'lwc';
import openCases from '@salesforce/apex/CaseService.openCases';
import REASON from '@salesforce/schema/Case.Escalation_Reason__c';

export default class CaseSummary extends LightningElement {
    @wire(openCases, { accountIds: '$ids' }) cases;
    reasonField = REASON;
}
