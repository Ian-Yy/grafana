import { filter, startsWith } from 'lodash';
import UrlBuilder from './url_builder';
import ResponseParser from './response_parser';
import SupportedNamespaces from './supported_namespaces';
import TimegrainConverter from '../time_grain_converter';
import {
  AzureMonitorQuery,
  AzureDataSourceJsonData,
  AzureMonitorMetricDefinitionsResponse,
  AzureMonitorResourceGroupsResponse,
  AzureQueryType,
  AzureMonitorMetricsMetadataResponse,
  AzureMetricQuery,
} from '../types';
import {
  DataSourceInstanceSettings,
  ScopedVars,
  MetricFindValue,
  DataQueryResponse,
  DataQueryRequest,
  TimeRange,
} from '@grafana/data';
import { getBackendSrv, DataSourceWithBackend, getTemplateSrv, FetchResponse } from '@grafana/runtime';
import { from, Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

import { getTimeSrv, TimeSrv } from 'app/features/dashboard/services/TimeSrv';
import { getAzureCloud } from '../credentials';
import { getManagementApiRoute } from '../api/routes';

const defaultDropdownValue = 'select';

// Used to convert our aggregation value to the Azure enum for deep linking
const aggregationTypeMap: Record<string, number> = {
  None: 0,
  Total: 1,
  Minimum: 2,
  Maximum: 3,
  Average: 4,
  Count: 7,
};

export default class AzureMonitorDatasource extends DataSourceWithBackend<AzureMonitorQuery, AzureDataSourceJsonData> {
  apiVersion = '2018-01-01';
  apiPreviewVersion = '2017-12-01-preview';
  subscriptionId: string;
  baseUrl: string;
  resourceGroup: string;
  resourceName: string;
  url: string;
  supportedMetricNamespaces: string[] = [];
  timeSrv: TimeSrv;

  constructor(private instanceSettings: DataSourceInstanceSettings<AzureDataSourceJsonData>) {
    super(instanceSettings);

    this.timeSrv = getTimeSrv();
    this.subscriptionId = instanceSettings.jsonData.subscriptionId;

    const cloud = getAzureCloud(instanceSettings);
    const route = getManagementApiRoute(cloud);
    this.baseUrl = `/${route}/subscriptions`;

    this.url = instanceSettings.url!;
    this.supportedMetricNamespaces = new SupportedNamespaces(cloud).get();
  }

  isConfigured(): boolean {
    return !!this.subscriptionId && this.subscriptionId.length > 0;
  }

  filterQuery(item: AzureMonitorQuery): boolean {
    return !!(
      item.hide !== true &&
      item.azureMonitor.resourceGroup &&
      item.azureMonitor.resourceGroup !== defaultDropdownValue &&
      item.azureMonitor.resourceName &&
      item.azureMonitor.resourceName !== defaultDropdownValue &&
      item.azureMonitor.metricDefinition &&
      item.azureMonitor.metricDefinition !== defaultDropdownValue &&
      item.azureMonitor.metricName &&
      item.azureMonitor.metricName !== defaultDropdownValue &&
      item.azureMonitor.aggregation &&
      item.azureMonitor.aggregation !== defaultDropdownValue
    );
  }

  query(request: DataQueryRequest<AzureMonitorQuery>): Observable<DataQueryResponse> {
    const metricQueries = request.targets.reduce((prev: Record<string, AzureMonitorQuery>, cur) => {
      prev[cur.refId] = cur;
      return prev;
    }, {});

    return super.query(request).pipe(
      mergeMap((res: DataQueryResponse) => {
        return from(this.processResponse(res, metricQueries));
      })
    );
  }

  async processResponse(
    res: DataQueryResponse,
    metricQueries: Record<string, AzureMonitorQuery>
  ): Promise<DataQueryResponse> {
    if (res.data) {
      for (const df of res.data) {
        const metricQuery = metricQueries[df.refId]?.azureMonitor;
        if (metricQuery) {
          const url = this.buildAzurePortalUrl(metricQuery, this.subscriptionId, this.timeSrv.timeRange());

          for (const field of df.fields) {
            field.config.links = [
              {
                url: url,
                title: 'View in Azure Portal',
                targetBlank: true,
              },
            ];
          }
        }
      }
    }
    return res;
  }

  stringifyAzurePortalUrlParam(value: string | object): string {
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    return encodeURIComponent(stringValue);
  }

  buildAzurePortalUrl(metricQuery: AzureMetricQuery, subscriptionId: string, timeRange: TimeRange) {
    const aggregationType =
      (metricQuery.aggregation && aggregationTypeMap[metricQuery.aggregation]) ?? aggregationTypeMap.Average;

    const chartDef = this.stringifyAzurePortalUrlParam({
      v2charts: [
        {
          metrics: [
            {
              resourceMetadata: {
                id: `/subscriptions/${subscriptionId}/resourceGroups/${metricQuery.resourceGroup}/providers/${metricQuery.metricDefinition}/${metricQuery.resourceName}`,
              },
              name: metricQuery.metricName,
              aggregationType: aggregationType,
              namespace: metricQuery.metricNamespace,
              metricVisualization: {
                displayName: metricQuery.metricName,
                resourceDisplayName: metricQuery.resourceName,
              },
            },
          ],
        },
      ],
    });

    const timeContext = this.stringifyAzurePortalUrlParam({
      absolute: {
        startTime: timeRange.from,
        endTime: timeRange.to,
      },
    });

    return `https://portal.azure.com/#blade/Microsoft_Azure_MonitoringMetrics/Metrics.ReactView/Referer/MetricsExplorer/TimeContext/${timeContext}/ChartDefinition/${chartDef}`;
  }

  applyTemplateVariables(target: AzureMonitorQuery, scopedVars: ScopedVars): Record<string, any> {
    const item = target.azureMonitor;

    // fix for timeGrainUnit which is a deprecated/removed field name
    if (item.timeGrainUnit && item.timeGrain !== 'auto') {
      item.timeGrain = TimegrainConverter.createISO8601Duration(item.timeGrain, item.timeGrainUnit);
    }

    const templateSrv = getTemplateSrv();

    const subscriptionId = templateSrv.replace(target.subscription || this.subscriptionId, scopedVars);
    const resourceGroup = templateSrv.replace(item.resourceGroup, scopedVars);
    const resourceName = templateSrv.replace(item.resourceName, scopedVars);
    const metricNamespace = templateSrv.replace(item.metricNamespace, scopedVars);
    const metricDefinition = templateSrv.replace(item.metricDefinition, scopedVars);
    const timeGrain = templateSrv.replace((item.timeGrain || '').toString(), scopedVars);
    const aggregation = templateSrv.replace(item.aggregation, scopedVars);
    const top = templateSrv.replace(item.top || '', scopedVars);

    const dimensionFilters = item.dimensionFilters
      .filter((f) => f.dimension && f.dimension !== 'None')
      .map((f) => {
        const filter = templateSrv.replace(f.filter ?? '', scopedVars);
        return {
          dimension: templateSrv.replace(f.dimension, scopedVars),
          operator: f.operator || 'eq',
          filter: filter || '*', // send * when empty
        };
      });

    return {
      refId: target.refId,
      subscription: subscriptionId,
      queryType: AzureQueryType.AzureMonitor,
      azureMonitor: {
        resourceGroup,
        resourceName,
        metricDefinition,
        timeGrain,
        allowedTimeGrainsMs: item.allowedTimeGrainsMs,
        metricName: templateSrv.replace(item.metricName, scopedVars),
        metricNamespace:
          metricNamespace && metricNamespace !== defaultDropdownValue ? metricNamespace : metricDefinition,
        aggregation: aggregation,
        dimensionFilters,
        top: top || '10',
        alias: item.alias,
        format: target.format,
      },
    };
  }

  /**
   * This is named differently than DataSourceApi.metricFindQuery
   * because it's not exposed to Grafana like the main AzureMonitorDataSource.
   * And some of the azure internal data sources return null in this function, which the
   * external interface does not support
   */
  metricFindQueryInternal(query: string): Promise<MetricFindValue[]> | null {
    const subscriptionsQuery = query.match(/^Subscriptions\(\)/i);
    if (subscriptionsQuery) {
      return this.getSubscriptions();
    }

    const resourceGroupsQuery = query.match(/^ResourceGroups\(\)/i);
    if (resourceGroupsQuery) {
      return this.getResourceGroups(this.subscriptionId);
    }

    const resourceGroupsQueryWithSub = query.match(/^ResourceGroups\(([^\)]+?)(,\s?([^,]+?))?\)/i);
    if (resourceGroupsQueryWithSub) {
      return this.getResourceGroups(this.toVariable(resourceGroupsQueryWithSub[1]));
    }

    const metricDefinitionsQuery = query.match(/^Namespaces\(([^\)]+?)(,\s?([^,]+?))?\)/i);
    if (metricDefinitionsQuery) {
      if (!metricDefinitionsQuery[3]) {
        return this.getMetricDefinitions(this.subscriptionId, this.toVariable(metricDefinitionsQuery[1]));
      }
    }

    const metricDefinitionsQueryWithSub = query.match(/^Namespaces\(([^,]+?),\s?([^,]+?)\)/i);
    if (metricDefinitionsQueryWithSub) {
      return this.getMetricDefinitions(
        this.toVariable(metricDefinitionsQueryWithSub[1]),
        this.toVariable(metricDefinitionsQueryWithSub[2])
      );
    }

    const resourceNamesQuery = query.match(/^ResourceNames\(([^,]+?),\s?([^,]+?)\)/i);
    if (resourceNamesQuery) {
      const resourceGroup = this.toVariable(resourceNamesQuery[1]);
      const metricDefinition = this.toVariable(resourceNamesQuery[2]);
      return this.getResourceNames(this.subscriptionId, resourceGroup, metricDefinition);
    }

    const resourceNamesQueryWithSub = query.match(/^ResourceNames\(([^,]+?),\s?([^,]+?),\s?(.+?)\)/i);
    if (resourceNamesQueryWithSub) {
      const subscription = this.toVariable(resourceNamesQueryWithSub[1]);
      const resourceGroup = this.toVariable(resourceNamesQueryWithSub[2]);
      const metricDefinition = this.toVariable(resourceNamesQueryWithSub[3]);
      return this.getResourceNames(subscription, resourceGroup, metricDefinition);
    }

    const metricNamespaceQuery = query.match(/^MetricNamespace\(([^,]+?),\s?([^,]+?),\s?([^,]+?)\)/i);
    if (metricNamespaceQuery) {
      const resourceGroup = this.toVariable(metricNamespaceQuery[1]);
      const metricDefinition = this.toVariable(metricNamespaceQuery[2]);
      const resourceName = this.toVariable(metricNamespaceQuery[3]);
      return this.getMetricNamespaces(this.subscriptionId, resourceGroup, metricDefinition, resourceName);
    }

    const metricNamespaceQueryWithSub = query.match(
      /^metricnamespace\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)\)/i
    );
    if (metricNamespaceQueryWithSub) {
      const subscription = this.toVariable(metricNamespaceQueryWithSub[1]);
      const resourceGroup = this.toVariable(metricNamespaceQueryWithSub[2]);
      const metricDefinition = this.toVariable(metricNamespaceQueryWithSub[3]);
      const resourceName = this.toVariable(metricNamespaceQueryWithSub[4]);
      return this.getMetricNamespaces(subscription, resourceGroup, metricDefinition, resourceName);
    }

    const metricNamesQuery = query.match(/^MetricNames\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?)\)/i);
    if (metricNamesQuery) {
      if (metricNamesQuery[3].indexOf(',') === -1) {
        const resourceGroup = this.toVariable(metricNamesQuery[1]);
        const metricDefinition = this.toVariable(metricNamesQuery[2]);
        const resourceName = this.toVariable(metricNamesQuery[3]);
        const metricNamespace = this.toVariable(metricNamesQuery[4]);
        return this.getMetricNames(this.subscriptionId, resourceGroup, metricDefinition, resourceName, metricNamespace);
      }
    }

    const metricNamesQueryWithSub = query.match(
      /^MetricNames\(([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?([^,]+?),\s?(.+?)\)/i
    );

    if (metricNamesQueryWithSub) {
      const subscription = this.toVariable(metricNamesQueryWithSub[1]);
      const resourceGroup = this.toVariable(metricNamesQueryWithSub[2]);
      const metricDefinition = this.toVariable(metricNamesQueryWithSub[3]);
      const resourceName = this.toVariable(metricNamesQueryWithSub[4]);
      const metricNamespace = this.toVariable(metricNamesQueryWithSub[5]);
      return this.getMetricNames(subscription, resourceGroup, metricDefinition, resourceName, metricNamespace);
    }

    return null;
  }

  toVariable(metric: string) {
    return getTemplateSrv().replace((metric || '').trim());
  }

  getSubscriptions() {
    const url = `${this.baseUrl}?api-version=2019-03-01`;
    return this.doRequest(url).then((result: any) => {
      return ResponseParser.parseSubscriptions(result);
    });
  }

  getResourceGroups(subscriptionId: string) {
    const url = `${this.baseUrl}/${subscriptionId}/resourceGroups?api-version=${this.apiVersion}`;
    return this.doRequest(url).then((result: AzureMonitorResourceGroupsResponse) => {
      return ResponseParser.parseResponseValues(result, 'name', 'name');
    });
  }

  getMetricDefinitions(subscriptionId: string, resourceGroup: string) {
    const url = `${this.baseUrl}/${subscriptionId}/resourceGroups/${resourceGroup}/resources?api-version=${this.apiVersion}`;
    return this.doRequest(url)
      .then((result: AzureMonitorMetricDefinitionsResponse) => {
        return ResponseParser.parseResponseValues(result, 'type', 'type');
      })
      .then((result) => {
        return filter(result, (t) => {
          for (let i = 0; i < this.supportedMetricNamespaces.length; i++) {
            if (t.value.toLowerCase() === this.supportedMetricNamespaces[i].toLowerCase()) {
              return true;
            }
          }

          return false;
        });
      })
      .then((result) => {
        let shouldHardcodeBlobStorage = false;
        for (let i = 0; i < result.length; i++) {
          if (result[i].value === 'Microsoft.Storage/storageAccounts') {
            shouldHardcodeBlobStorage = true;
            break;
          }
        }

        if (shouldHardcodeBlobStorage) {
          result.push({
            text: 'Microsoft.Storage/storageAccounts/blobServices',
            value: 'Microsoft.Storage/storageAccounts/blobServices',
          });
          result.push({
            text: 'Microsoft.Storage/storageAccounts/fileServices',
            value: 'Microsoft.Storage/storageAccounts/fileServices',
          });
          result.push({
            text: 'Microsoft.Storage/storageAccounts/tableServices',
            value: 'Microsoft.Storage/storageAccounts/tableServices',
          });
          result.push({
            text: 'Microsoft.Storage/storageAccounts/queueServices',
            value: 'Microsoft.Storage/storageAccounts/queueServices',
          });
        }

        return result;
      });
  }

  getResourceNames(subscriptionId: string, resourceGroup: string, metricDefinition: string) {
    const url = `${this.baseUrl}/${subscriptionId}/resourceGroups/${resourceGroup}/resources?api-version=${this.apiVersion}`;

    return this.doRequest(url).then((result: any) => {
      if (!startsWith(metricDefinition, 'Microsoft.Storage/storageAccounts/')) {
        return ResponseParser.parseResourceNames(result, metricDefinition);
      }

      const list = ResponseParser.parseResourceNames(result, 'Microsoft.Storage/storageAccounts');
      for (let i = 0; i < list.length; i++) {
        list[i].text += '/default';
        list[i].value += '/default';
      }

      return list;
    });
  }

  getMetricNamespaces(subscriptionId: string, resourceGroup: string, metricDefinition: string, resourceName: string) {
    const url = UrlBuilder.buildAzureMonitorGetMetricNamespacesUrl(
      this.baseUrl,
      subscriptionId,
      resourceGroup,
      metricDefinition,
      resourceName,
      this.apiPreviewVersion
    );

    return this.doRequest(url).then((result: any) => {
      return ResponseParser.parseResponseValues(result, 'name', 'properties.metricNamespaceName');
    });
  }

  getMetricNames(
    subscriptionId: string,
    resourceGroup: string,
    metricDefinition: string,
    resourceName: string,
    metricNamespace: string
  ) {
    const url = UrlBuilder.buildAzureMonitorGetMetricNamesUrl(
      this.baseUrl,
      subscriptionId,
      resourceGroup,
      metricDefinition,
      resourceName,
      metricNamespace,
      this.apiVersion
    );

    return this.doRequest(url).then((result: any) => {
      return ResponseParser.parseResponseValues(result, 'name.localizedValue', 'name.value');
    });
  }

  getMetricMetadata(
    subscriptionId: string,
    resourceGroup: string,
    metricDefinition: string,
    resourceName: string,
    metricNamespace: string,
    metricName: string
  ) {
    const url = UrlBuilder.buildAzureMonitorGetMetricNamesUrl(
      this.baseUrl,
      subscriptionId,
      resourceGroup,
      metricDefinition,
      resourceName,
      metricNamespace,
      this.apiVersion
    );

    return this.doRequest<AzureMonitorMetricsMetadataResponse>(url).then((result) => {
      return ResponseParser.parseMetadata(result.data, metricName);
    });
  }

  testDatasource(): Promise<any> {
    if (!this.isValidConfigField(this.instanceSettings.jsonData.tenantId)) {
      return Promise.resolve({
        status: 'error',
        message: 'The Tenant Id field is required.',
      });
    }

    if (!this.isValidConfigField(this.instanceSettings.jsonData.clientId)) {
      return Promise.resolve({
        status: 'error',
        message: 'The Client Id field is required.',
      });
    }

    const url = `${this.baseUrl}?api-version=2019-03-01`;
    return this.doRequest(url)
      .then((response: any) => {
        if (response.status === 200) {
          return {
            status: 'success',
            message: 'Successfully queried the Azure Monitor service.',
            title: 'Success',
          };
        }

        return {
          status: 'error',
          message: 'Returned http status code ' + response.status,
        };
      })
      .catch((error: any) => {
        let message = 'Azure Monitor: ';
        message += error.statusText ? error.statusText + ': ' : '';

        if (error.data && error.data.error && error.data.error.code) {
          message += error.data.error.code + '. ' + error.data.error.message;
        } else if (error.data && error.data.error) {
          message += error.data.error;
        } else if (error.data) {
          message += error.data;
        } else {
          message += 'Cannot connect to Azure Monitor REST API.';
        }
        return {
          status: 'error',
          message: message,
        };
      });
  }

  isValidConfigField(field?: string) {
    return field && field.length > 0;
  }

  doRequest<T = any>(url: string, maxRetries = 1): Promise<FetchResponse<T>> {
    return getBackendSrv()
      .datasourceRequest<T>({
        url: this.url + url,
        method: 'GET',
      })
      .catch((error: any) => {
        if (maxRetries > 0) {
          return this.doRequest<T>(url, maxRetries - 1);
        }

        throw error;
      });
  }
}
