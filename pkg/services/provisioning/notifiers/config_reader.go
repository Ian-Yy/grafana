package notifiers

import (
	"context"
	"fmt"
	"io/ioutil"
	"os"
	"path/filepath"
	"strings"

	"github.com/grafana/grafana/pkg/infra/log"
	"github.com/grafana/grafana/pkg/models"
	"github.com/grafana/grafana/pkg/services/alerting"
	"github.com/grafana/grafana/pkg/services/encryption"
	"github.com/grafana/grafana/pkg/services/provisioning/utils"
	"github.com/grafana/grafana/pkg/setting"
	"gopkg.in/yaml.v2"
)

type configReader struct {
	encryptionService encryption.Service
	log               log.Logger
}

func (cr *configReader) readConfig(ctx context.Context, path string) ([]*notificationsAsConfig, error) {
	var notifications []*notificationsAsConfig
	cr.log.Debug("Looking for alert notification provisioning files", "path", path)

	files, err := ioutil.ReadDir(path)
	if err != nil {
		cr.log.Error("Can't read alert notification provisioning files from directory", "path", path, "error", err)
		return notifications, nil
	}

	for _, file := range files {
		if strings.HasSuffix(file.Name(), ".yaml") || strings.HasSuffix(file.Name(), ".yml") {
			cr.log.Debug("Parsing alert notifications provisioning file", "path", path, "file.Name", file.Name())
			notifs, err := cr.parseNotificationConfig(path, file)
			if err != nil {
				return nil, err
			}

			if notifs != nil {
				notifications = append(notifications, notifs)
			}
		}
	}

	cr.log.Debug("Validating alert notifications")
	if err = cr.validateRequiredField(notifications); err != nil {
		return nil, err
	}

	if err := cr.checkOrgIDAndOrgName(ctx, notifications); err != nil {
		return nil, err
	}

	if err := cr.validateNotifications(notifications); err != nil {
		return nil, err
	}

	return notifications, nil
}

func (cr *configReader) parseNotificationConfig(path string, file os.FileInfo) (*notificationsAsConfig, error) {
	filename, _ := filepath.Abs(filepath.Join(path, file.Name()))

	// nolint:gosec
	// We can ignore the gosec G304 warning on this one because `filename` comes from ps.Cfg.ProvisioningPath
	yamlFile, err := ioutil.ReadFile(filename)
	if err != nil {
		return nil, err
	}

	var cfg *notificationsAsConfigV0
	err = yaml.Unmarshal(yamlFile, &cfg)
	if err != nil {
		return nil, err
	}

	return cfg.mapToNotificationFromConfig(), nil
}

func (cr *configReader) checkOrgIDAndOrgName(ctx context.Context, notifications []*notificationsAsConfig) error {
	for i := range notifications {
		for _, notification := range notifications[i].Notifications {
			if notification.OrgID < 1 {
				if notification.OrgName == "" {
					notification.OrgID = 1
				} else {
					notification.OrgID = 0
				}
			} else {
				if err := utils.CheckOrgExists(ctx, notification.OrgID); err != nil {
					return fmt.Errorf("failed to provision %q notification: %w", notification.Name, err)
				}
			}
		}

		for _, notification := range notifications[i].DeleteNotifications {
			if notification.OrgID < 1 {
				if notification.OrgName == "" {
					notification.OrgID = 1
				} else {
					notification.OrgID = 0
				}
			}
		}
	}
	return nil
}

func (cr *configReader) validateRequiredField(notifications []*notificationsAsConfig) error {
	for i := range notifications {
		var errStrings []string
		for index, notification := range notifications[i].Notifications {
			if notification.Name == "" {
				errStrings = append(
					errStrings,
					fmt.Sprintf("Added alert notification item %d in configuration doesn't contain required field name", index+1),
				)
			}

			if notification.UID == "" {
				errStrings = append(
					errStrings,
					fmt.Sprintf("Added alert notification item %d in configuration doesn't contain required field uid", index+1),
				)
			}
		}

		for index, notification := range notifications[i].DeleteNotifications {
			if notification.Name == "" {
				errStrings = append(
					errStrings,
					fmt.Sprintf("Deleted alert notification item %d in configuration doesn't contain required field name", index+1),
				)
			}

			if notification.UID == "" {
				errStrings = append(
					errStrings,
					fmt.Sprintf("Deleted alert notification item %d in configuration doesn't contain required field uid", index+1),
				)
			}
		}

		if len(errStrings) != 0 {
			return fmt.Errorf(strings.Join(errStrings, "\n"))
		}
	}

	return nil
}

func (cr *configReader) validateNotifications(notifications []*notificationsAsConfig) error {
	for i := range notifications {
		if notifications[i].Notifications == nil {
			continue
		}

		for _, notification := range notifications[i].Notifications {
			encryptedSecureSettings, err := cr.encryptionService.EncryptJsonData(
				context.Background(),
				notification.SecureSettings,
				setting.SecretKey,
			)

			if err != nil {
				return err
			}

			_, err = alerting.InitNotifier(&models.AlertNotification{
				Name:           notification.Name,
				Settings:       notification.SettingsToJSON(),
				SecureSettings: encryptedSecureSettings,
				Type:           notification.Type,
			}, cr.encryptionService.GetDecryptedValue)

			if err != nil {
				return err
			}
		}
	}

	return nil
}
