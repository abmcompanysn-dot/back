package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// Configuration
var (
	dbUser      *gorm.DB
	kafkaWriter *kafka.Writer
)

// Models
type User struct {
	ID              uint      `gorm:"primaryKey" json:"id"`
	Email           string    `gorm:"uniqueIndex;not null" json:"email"`
	Password        string    `gorm:"not null" json:"-"`
	FirstName       string    `json:"first_name"`
	LastName        string    `json:"last_name"`
	Phone           string    `json:"phone"`
	Role            string    `gorm:"default:'customer'" json:"role"` // customer, vendor, admin
	Status          string    `gorm:"default:'active'" json:"status"` // active, suspended, deleted
	AvatarURL       string    `json:"avatar_url"`
	Bio             string    `json:"bio"`
	Address         string    `json:"address"`
	City            string    `json:"city"`
	Country         string    `json:"country"`
	PostalCode      string    `json:"postal_code"`
	IsEmailVerified bool      `gorm:"default:false" json:"is_email_verified"`
	IsPhoneVerified bool      `gorm:"default:false" json:"is_phone_verified"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
	DeletedAt       gorm.DeletedAt `gorm:"index" json:"-"`
}

type UserProfile struct {
	ID           uint   `gorm:"primaryKey" json:"id"`
	UserID       uint   `gorm:"uniqueIndex;not null" json:"user_id"`
	BirthDate    *time.Time `json:"birth_date"`
	Gender       string `json:"gender"` // male, female, other
	Language     string `gorm:"default:'fr'" json:"language"`
	Timezone     string `gorm:"default:'UTC'" json:"timezone"`
	Newsletter   bool   `gorm:"default:false" json:"newsletter"`
	Notifications bool `gorm:"default:true" json:"notifications"`
}

type Role struct {
	ID          uint   `gorm:"primaryKey" json:"id"`
	Name        string `gorm:"uniqueIndex;not null" json:"name"` // admin, vendor, customer
	Description string `json:"description"`
	Permissions JSONB  `gorm:"type:jsonb" json:"permissions"`
}

type Permission struct {
	ID     uint   `gorm:"primaryKey" json:"id"`
	Name   string `gorm:"uniqueIndex;not null" json:"name"`
	Resource string `json:"resource"` // products, orders, users, etc.
	Action string `json:"action"`     // create, read, update, delete
}

type JSONB map[string]interface{}

func (JSONB) GormDataType() string {
	return "jsonb"
}

// DTOs
type CreateUserRequest struct {
	Email     string `json:"email" validate:"required,email"`
	Password  string `json:"password" validate:"required,min=8"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Phone     string `json:"phone"`
	Role      string `json:"role"`
}

type UpdateUserRequest struct {
	FirstName  *string `json:"first_name"`
	LastName   *string `json:"last_name"`
	Phone      *string `json:"phone"`
	AvatarURL  *string `json:"avatar_url"`
	Bio        *string `json:"bio"`
	Address    *string `json:"address"`
	City       *string `json:"city"`
	Country    *string `json:"country"`
	PostalCode *string `json:"postal_code"`
}

type LoginRequest struct {
	Email    string `json:"email" validate:"required,email"`
	Password string `json:"password" validate:"required"`
}

type LoginResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

type APIResponse struct {
	Success bool        `json:"success"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

func main() {
	// Database connection
	dsn := os.Getenv("DATABASE_URL_USER")
	if dsn == "" {
		dsn = "postgres://miad:miad_pass@localhost:5432/miad_users?sslmode=disable"
	}

	var err error
	dbUser, err = gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	// Auto migrate
	err = dbUser.AutoMigrate(&User{}, &UserProfile{}, &Role{}, &Permission{})
	if err != nil {
		log.Fatal("Failed to migrate database:", err)
	}

	// Create default roles if not exist
	createDefaultRoles()

	// Kafka setup
	kafkaWriter = &kafka.Writer{
		Addr:     kafka.TCP(os.Getenv("KAFKA_BROKER")),
		Topic:    "user.events",
		Balancer: &kafka.LeastBytes{},
	}

	// Routes
	http.HandleFunc("/health", healthHandler)
	http.HandleFunc("/api/v1/users/register", registerHandler)
	http.HandleFunc("/api/v1/users/login", loginHandler)
	http.HandleFunc("/api/v1/users/", userHandler)
	http.HandleFunc("/api/v1/users/profile", profileHandler)
	http.HandleFunc("/api/v1/users/verify-email", verifyEmailHandler)
	http.HandleFunc("/api/v1/users/reset-password", resetPasswordHandler)
	http.HandleFunc("/api/v1/roles", rolesHandler)

	port := os.Getenv("PORT_USER")
	if port == "" {
		port = "8087"
	}

	log.Printf("🚀 User service starting on port %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func createDefaultRoles() {
	roles := []Role{
		{Name: "admin", Description: "Administrateur système", Permissions: JSONB{"all": true}},
		{Name: "vendor", Description: "Vendeur", Permissions: JSONB{"products": []string{"create", "read", "update", "delete"}, "orders": []string{"read", "update"}}},
		{Name: "customer", Description: "Client", Permissions: JSONB{"products": []string{"read"}, "orders": []string{"create", "read"}}},
	}

	for _, role := range roles {
		var existing Role
		result := dbUser.Where("name = ?", role.Name).First(&existing)
		if result.Error != nil {
			dbUser.Create(&role)
		}
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(APIResponse{Success: true, Message: "User service is healthy"})
}

func registerHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Method not allowed"})
		return
	}

	var req CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Invalid request body"})
		return
	}

	// Validate email format
	if !strings.Contains(req.Email, "@") || !strings.Contains(req.Email, ".") {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Invalid email format"})
		return
	}

	// Check if user exists
	var existing User
	if result := dbUser.Where("email = ?", req.Email).First(&existing); result.Error == nil {
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Email already registered"})
		return
	}

	// Hash password
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Failed to hash password"})
		return
	}

	// Set default role
	if req.Role == "" {
		req.Role = "customer"
	}

	// Create user
	user := User{
		Email:    strings.ToLower(req.Email),
		Password: string(hashedPassword),
		FirstName: req.FirstName,
		LastName:  req.LastName,
		Phone:     req.Phone,
		Role:      req.Role,
		Status:    "active",
	}

	if err := dbUser.Create(&user).Error; err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Failed to create user"})
		return
	}

	// Create user profile
	profile := UserProfile{
		UserID: user.ID,
		Language: "fr",
		Timezone: "UTC",
		Notifications: true,
	}
	dbUser.Create(&profile)

	// Publish event to Kafka
	event := map[string]interface{}{
		"event_type": "user.registered",
		"user_id":    user.ID,
		"email":      user.Email,
		"role":       user.Role,
		"timestamp":  time.Now().UTC(),
	}

	publishKafkaEvent("user.registered", event)

	// Send welcome email via notification service
	notification := map[string]interface{}{
		"user_id": user.ID,
		"email":   user.Email,
		"type":    "welcome",
		"data": map[string]string{
			"first_name": user.FirstName,
			"email":      user.Email,
		},
	}
	publishKafkaEvent("notification.email", notification)

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(APIResponse{
		Success: true,
		Message: "User registered successfully",
		Data: map[string]interface{}{
			"user_id": user.ID,
			"email":   user.Email,
			"role":    user.Role,
		},
	})
}

func loginHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Method not allowed"})
		return
	}

	var req LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Invalid request body"})
		return
	}

	// Find user
	var user User
	if err := dbUser.Where("email = ?", strings.ToLower(req.Email)).First(&user).Error; err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Invalid credentials"})
		return
	}

	// Check password
	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(req.Password)); err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Invalid credentials"})
		return
	}

	// Check status
	if user.Status != "active" {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Account is suspended or deleted"})
		return
	}

	// Generate JWT token (simplified - in production use proper JWT library)
	token := fmt.Sprintf("mock_jwt_%d_%s", user.ID, time.Now().Format("20060102"))

	// Publish login event
	event := map[string]interface{}{
		"event_type": "user.logged_in",
		"user_id":    user.ID,
		"email":      user.Email,
		"timestamp":  time.Now().UTC(),
	}
	publishKafkaEvent("user.logged_in", event)

	json.NewEncoder(w).Encode(LoginResponse{
		Token: token,
		User:  user,
	})
}

func userHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	path := strings.TrimPrefix(r.URL.Path, "/api/v1/users/")
	
	// Handle specific user ID
	if path != "" && !strings.Contains(path, "/") {
		switch r.Method {
		case http.MethodGet:
			getUserByID(w, path)
		case http.MethodPut:
			updateUser(w, path)
		case http.MethodDelete:
			deleteUser(w, path)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Method not allowed"})
		}
		return
	}

	// List users
	if r.Method == http.MethodGet {
		listUsers(w, r)
	} else {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Method not allowed"})
	}
}

func getUserByID(w http.ResponseWriter, idStr string) {
	var user User
	if err := dbUser.First(&user, idStr).Error; err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "User not found"})
		return
	}

	json.NewEncoder(w).Encode(APIResponse{
		Success: true,
		Data:    user,
	})
}

func listUsers(w http.ResponseWriter, r *http.Request) {
	page := 1
	limit := 20
	
	users := []User{}
	query := dbUser.Model(&User{})
	
	// Apply filters
	if role := r.URL.Query().Get("role"); role != "" {
		query = query.Where("role = ?", role)
	}
	if status := r.URL.Query().Get("status"); status != "" {
		query = query.Where("status = ?", status)
	}
	
	query.Count(&page)
	query.Offset((page - 1) * limit).Limit(limit).Find(&users)

	json.NewEncoder(w).Encode(APIResponse{
		Success: true,
		Data: map[string]interface{}{
			"users": users,
			"total": page,
			"page":  page,
			"limit": limit,
		},
	})
}

func updateUser(w http.ResponseWriter, idStr string) {
	var req UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Invalid request body"})
		return
	}

	var user User
	if err := dbUser.First(&user, idStr).Error; err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "User not found"})
		return
	}

	// Update fields
	if req.FirstName != nil {
		user.FirstName = *req.FirstName
	}
	if req.LastName != nil {
		user.LastName = *req.LastName
	}
	if req.Phone != nil {
		user.Phone = *req.Phone
	}
	if req.AvatarURL != nil {
		user.AvatarURL = *req.AvatarURL
	}
	if req.Bio != nil {
		user.Bio = *req.Bio
	}
	if req.Address != nil {
		user.Address = *req.Address
	}
	if req.City != nil {
		user.City = *req.City
	}
	if req.Country != nil {
		user.Country = *req.Country
	}
	if req.PostalCode != nil {
		user.PostalCode = *req.PostalCode
	}

	if err := dbUser.Save(&user).Error; err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Failed to update user"})
		return
	}

	// Publish event
	event := map[string]interface{}{
		"event_type": "user.updated",
		"user_id":    user.ID,
		"timestamp":  time.Now().UTC(),
	}
	publishKafkaEvent("user.updated", event)

	json.NewEncoder(w).Encode(APIResponse{
		Success: true,
		Message: "User updated successfully",
		Data:    user,
	})
}

func deleteUser(w http.ResponseWriter, idStr string) {
	var user User
	if err := dbUser.First(&user, idStr).Error; err != nil {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "User not found"})
		return
	}

	// Soft delete
	user.Status = "deleted"
	if err := dbUser.Delete(&user).Error; err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Failed to delete user"})
		return
	}

	// Publish event
	event := map[string]interface{}{
		"event_type": "user.deleted",
		"user_id":    user.ID,
		"timestamp":  time.Now().UTC(),
	}
	publishKafkaEvent("user.deleted", event)

	json.NewEncoder(w).Encode(APIResponse{
		Success: true,
		Message: "User deleted successfully",
	})
}

func profileHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Method not allowed"})
		return
	}

	// In production, extract user ID from JWT token
	// For now, using query param for demo
	userID := r.URL.Query().Get("user_id")
	if userID == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "user_id required"})
		return
	}

	var profile UserProfile
	if r.Method == http.MethodGet {
		if err := dbUser.Where("user_id = ?", userID).First(&profile).Error; err != nil {
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Profile not found"})
			return
		}
		json.NewEncoder(w).Encode(APIResponse{Success: true, Data: profile})
	} else if r.Method == http.MethodPut {
		// Update profile logic here
		json.NewEncoder(w).Encode(APIResponse{Success: true, Message: "Profile updated"})
	}
}

func verifyEmailHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Method not allowed"})
		return
	}

	// Verify email logic with OTP
	json.NewEncoder(w).Encode(APIResponse{
		Success: true,
		Message: "Email verification sent",
	})
}

func resetPasswordHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Method not allowed"})
		return
	}

	// Reset password logic
	json.NewEncoder(w).Encode(APIResponse{
		Success: true,
		Message: "Password reset email sent",
	})
}

func rolesHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(APIResponse{Success: false, Error: "Method not allowed"})
		return
	}

	var roles []Role
	dbUser.Find(&roles)

	json.NewEncoder(w).Encode(APIResponse{
		Success: true,
		Data:    roles,
	})
}

func publishKafkaEvent(eventType string, data map[string]interface{}) {
	message, _ := json.Marshal(data)
	
	err := kafkaWriter.WriteMessages(context.Background(),
		kafka.Message{
			Key:   []byte(eventType),
			Value: message,
		},
	)
	
	if err != nil {
		log.Printf("Failed to publish Kafka event %s: %v", eventType, err)
	} else {
		log.Printf("✅ Published event: %s", eventType)
	}
}
